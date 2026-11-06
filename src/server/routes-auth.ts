import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sendTest } from "./alerts.ts";
import type { Ctx, Env } from "./context.ts";
import { HttpError } from "./context.ts";
import {
  SESSION_COOKIE,
  createSession,
  dummyHash,
  hashPassword,
  rateLimit,
  requireAuth,
  requireOwner,
  roleIn,
  safeEqual,
  sha256,
  verifyPassword,
} from "./auth.ts";
import { httpUrl, id, optNum, optStr, readBody, str, timezone } from "./validate.ts";

const DEFAULT_LOCATIONS: [string, string][] = [
  ["Pantry", "pantry"],
  ["Refrigerator", "fridge"],
  ["Freezer", "freezer"],
];

function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
}

function startSession(c: Context, ctx: Ctx, userId: number): void {
  const { token, maxAge } = createSession(ctx, userId);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: isHttps(c), path: "/", maxAge });
}

function createHousehold(ctx: Ctx, userId: number, name: string, tz: string): number {
  const h = Number(ctx.db.prepare("INSERT INTO households(name,timezone) VALUES (?,?)").run(name, tz).lastInsertRowid);
  ctx.db.prepare("INSERT INTO memberships(user_id,household_id,role) VALUES (?,?,'owner')").run(userId, h);
  for (const [n, k] of DEFAULT_LOCATIONS) ctx.db.prepare("INSERT INTO locations(household_id,name,kind) VALUES (?,?,?)").run(h, n, k);
  return h;
}

function householdsFor(ctx: Ctx, userId: number) {
  const rows = ctx.db
    .prepare(
      `SELECT h.id, h.name, m.role, h.timezone, h.expiry_warning_days, h.alert_hour, h.ntfy_url, h.webhook_url
       FROM memberships m JOIN households h ON h.id = m.household_id WHERE m.user_id = ? ORDER BY h.name`,
    )
    .all(userId) as Record<string, unknown>[];
  // Alert targets are secrets-ish (topic URLs); only owners see them.
  return rows.map((r) => (r.role === "owner" ? r : { ...r, ntfy_url: null, webhook_url: null }));
}

export function registerAuthRoutes(app: Hono<Env>, ctx: Ctx): void {
  const auth = requireAuth(ctx);
  const limit = rateLimit(10, 15 * 60_000, ctx.now);

  app.post("/api/setup", limit, async (c) => {
    const body = await readBody(c);
    if (!ctx.setupToken) throw new HttpError(503, "SHELFIE_SETUP_TOKEN is not set on the server");
    if (typeof body.token !== "string" || !safeEqual(body.token, ctx.setupToken)) throw new HttpError(403, "Invalid setup token");
    const username = str(body, "username", 2, 40);
    const password = str(body, "password", 8, 200);
    const householdName = str(body, "household_name", 1, 80);
    const tz = timezone(optStr(body, "timezone", 64) ?? "UTC");
    const userId = ctx.db.transaction(() => {
      const { n } = ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
      if (n > 0) throw new HttpError(409, "This instance is already set up");
      const u = Number(
        ctx.db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES (?,?,1)").run(username, hashPassword(password, ctx.passwordMode)).lastInsertRowid,
      );
      createHousehold(ctx, u, householdName, tz);
      return u;
    });
    startSession(c, ctx, userId);
    return c.json({ ok: true });
  });

  app.post("/api/login", limit, async (c) => {
    const body = await readBody(c);
    const username = str(body, "username", 1, 40);
    const password = typeof body.password === "string" ? body.password : "";
    const row = ctx.db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(username) as
      | { id: number; password_hash: string }
      | undefined;
    // Always run a hash comparison so response time does not reveal valid usernames.
    const ok = verifyPassword(password, row?.password_hash ?? dummyHash(ctx.passwordMode));
    if (!row || !ok) throw new HttpError(401, "Invalid username or password");
    startSession(c, ctx, row.id);
    return c.json({ ok: true });
  });

  app.post("/api/logout", async (c) => {
    const cookie = c.req.header("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
    if (cookie) {
      ctx.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(cookie));
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/me", auth, (c) => {
    const user = c.get("user");
    return c.json({ ...user, households: householdsFor(ctx, user.id) });
  });

  // Signs every other device out, so a leaked password cannot keep a session alive after it is changed.
  // A wrong current password is a 403, not a 401: a 401 would send the app back to the login screen.
  app.post("/api/me/password", auth, limit, async (c) => {
    const user = c.get("user");
    const body = await readBody(c);
    const current = typeof body.current_password === "string" ? body.current_password : "";
    const next = str(body, "new_password", 8, 200);
    const row = ctx.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string };
    if (!verifyPassword(current, row.password_hash)) throw new HttpError(403, "Current password is incorrect");
    const keep = sha256(getCookie(c, SESSION_COOKIE) ?? "");
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(next, ctx.passwordMode), user.id);
      ctx.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(user.id, keep);
    });
    return c.json({ ok: true });
  });

  // Instance admins create accounts for other people. Each account gets a household of its own, so pantries
  // stay separate; the admin is not added to it.
  app.get("/api/admin/users", auth, (c) => {
    if (!c.get("user").is_admin) throw new HttpError(403, "Only instance admins can do this");
    const users = ctx.db.prepare("SELECT id, username, is_admin, created_at FROM users ORDER BY username").all() as {
      id: number;
      username: string;
      is_admin: number;
      created_at: string;
    }[];
    const memberships = ctx.db
      .prepare("SELECT m.user_id, h.name, m.role FROM memberships m JOIN households h ON h.id = m.household_id ORDER BY h.name")
      .all() as { user_id: number; name: string; role: string }[];
    return c.json(
      users.map((u) => ({
        id: u.id,
        username: u.username,
        is_admin: u.is_admin === 1,
        created_at: u.created_at,
        households: memberships.filter((m) => m.user_id === u.id).map((m) => ({ name: m.name, role: m.role })),
      })),
    );
  });

  app.post("/api/admin/users", auth, async (c) => {
    if (!c.get("user").is_admin) throw new HttpError(403, "Only instance admins can do this");
    const body = await readBody(c);
    const username = str(body, "username", 2, 40);
    const password = str(body, "password", 8, 200);
    const householdName = optStr(body, "household_name", 80) ?? `${username}'s pantry`;
    const tz = timezone(optStr(body, "timezone", 64) ?? "UTC");
    const created = ctx.db.transaction(() => {
      if (ctx.db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw new HttpError(409, "That username is taken");
      const userId = Number(
        ctx.db.prepare("INSERT INTO users(username,password_hash) VALUES (?,?)").run(username, hashPassword(password, ctx.passwordMode)).lastInsertRowid,
      );
      return { id: userId, household_id: createHousehold(ctx, userId, householdName, tz) };
    });
    return c.json({ ...created, username, household_name: householdName }, 201);
  });

  // For someone who forgot their password. Signs them out everywhere. Admins change their own with /api/me/password.
  app.post("/api/admin/users/:userId/password", auth, async (c) => {
    const admin = c.get("user");
    if (!admin.is_admin) throw new HttpError(403, "Only instance admins can do this");
    const uid = id(c.req.param("userId"), "user");
    if (uid === admin.id) throw new HttpError(400, "Use Change password for your own account");
    const body = await readBody(c);
    const password = str(body, "password", 8, 200);
    if (!ctx.db.prepare("SELECT 1 FROM users WHERE id = ?").get(uid)) throw new HttpError(404, "User not found");
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password, ctx.passwordMode), uid);
      ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(uid);
    });
    return c.json({ ok: true });
  });

  app.post("/api/households", auth, async (c) => {
    const user = c.get("user");
    if (!user.is_admin) throw new HttpError(403, "Only instance admins can create households");
    const body = await readBody(c);
    const name = str(body, "name", 1, 80);
    const tz = timezone(optStr(body, "timezone", 64) ?? "UTC");
    const hid = ctx.db.transaction(() => createHousehold(ctx, user.id, name, tz));
    return c.json({ id: hid, name }, 201);
  });

  app.patch("/api/households/:id", auth, async (c) => {
    const user = c.get("user");
    const hid = id(c.req.param("id"));
    requireOwner(ctx, user.id, hid);
    const body = await readBody(c);
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (body.name !== undefined) (sets.push("name = ?"), vals.push(str(body, "name", 1, 80)));
    if (body.timezone !== undefined) (sets.push("timezone = ?"), vals.push(timezone(str(body, "timezone", 1, 64))));
    const days = optNum(body, "expiry_warning_days", { min: 0, max: 60, int: true });
    if (days !== undefined) (sets.push("expiry_warning_days = ?"), vals.push(days));
    const hour = optNum(body, "alert_hour", { min: 0, max: 23, int: true });
    if (hour !== undefined) (sets.push("alert_hour = ?"), vals.push(hour));
    if ("ntfy_url" in body) (sets.push("ntfy_url = ?"), vals.push(httpUrl(optStr(body, "ntfy_url", 500), "ntfy_url")));
    if ("webhook_url" in body) (sets.push("webhook_url = ?"), vals.push(httpUrl(optStr(body, "webhook_url", 500), "webhook_url")));
    if (!sets.length) throw new HttpError(400, "Nothing to update");
    ctx.db.prepare(`UPDATE households SET ${sets.join(", ")} WHERE id = ?`).run(...vals, hid);
    return c.json({ ok: true });
  });

  app.post("/api/households/:id/alerts/test", auth, async (c) => {
    const hid = id(c.req.param("id"));
    requireOwner(ctx, c.get("user").id, hid);
    const r = await sendTest(ctx, hid);
    if (!r.targets) throw new HttpError(400, "No alert target is configured");
    return c.json(r, r.sent ? 200 : 502);
  });

  app.get("/api/households/:id/members", auth, (c) => {
    const hid = id(c.req.param("id"));
    requireOwner(ctx, c.get("user").id, hid);
    const rows = ctx.db
      .prepare("SELECT u.id, u.username, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY u.username")
      .all(hid);
    return c.json(rows);
  });

  app.post("/api/households/:id/members", auth, async (c) => {
    const hid = id(c.req.param("id"));
    requireOwner(ctx, c.get("user").id, hid);
    const body = await readBody(c);
    const username = str(body, "username", 2, 40);
    const role = body.role === "owner" ? "owner" : "member";
    const existing = ctx.db.prepare("SELECT id FROM users WHERE username = ?").get(username) as { id: number } | undefined;
    let userId = existing?.id;
    if (!userId) {
      userId = Number(
        ctx.db.prepare("INSERT INTO users(username,password_hash) VALUES (?,?)").run(username, hashPassword(str(body, "password", 8, 200), ctx.passwordMode)).lastInsertRowid,
      );
    }
    ctx.db.prepare("INSERT INTO memberships(user_id,household_id,role) VALUES (?,?,?) ON CONFLICT(user_id,household_id) DO UPDATE SET role = excluded.role").run(userId, hid, role);
    return c.json({ id: userId, username, role }, 201);
  });

  app.delete("/api/households/:id/members/:userId", auth, (c) => {
    const hid = id(c.req.param("id"));
    const uid = id(c.req.param("userId"), "user");
    requireOwner(ctx, c.get("user").id, hid);
    const target = ctx.db.prepare("SELECT role FROM memberships WHERE user_id = ? AND household_id = ?").get(uid, hid) as { role: string } | undefined;
    if (!target) throw new HttpError(404, "Member not found");
    if (target.role === "owner") {
      const { n } = ctx.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE household_id = ? AND role = 'owner'").get(hid) as { n: number };
      if (n <= 1) throw new HttpError(409, "A household needs at least one owner");
    }
    ctx.db.prepare("DELETE FROM memberships WHERE user_id = ? AND household_id = ?").run(uid, hid);
    return c.json({ ok: true });
  });

  app.get("/api/households/:id/locations", auth, (c) => {
    const hid = id(c.req.param("id"));
    roleIn(ctx, c.get("user").id, hid);
    const rows = ctx.db
      .prepare("SELECT id, name, kind FROM locations WHERE household_id = ? ORDER BY CASE kind WHEN 'pantry' THEN 1 WHEN 'fridge' THEN 2 WHEN 'freezer' THEN 3 ELSE 4 END, name")
      .all(hid);
    return c.json(rows);
  });
}

