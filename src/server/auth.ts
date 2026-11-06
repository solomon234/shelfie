import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Ctx, Env, PasswordMode } from "./context.ts";
import { HttpError } from "./context.ts";

export const SESSION_COOKIE = "shelfie_session";
export const SESSION_DAYS = 30;

// Stored formats:
//   scrypt$<salt>$<hash>  "server" mode: the secret is the user's password, hashed here with scrypt.
//   proof$<salt>$<hash>   "client" mode: the secret is the browser's PBKDF2 output (already slow to guess),
//                         so a salted SHA-256 is enough and costs almost no CPU.
export function hashPassword(secret: string, mode: PasswordMode = "server"): string {
  const salt = randomBytes(16).toString("base64url");
  if (mode === "client") return `proof$${salt}$${sha256(`${salt}:${secret}`)}`;
  return `scrypt$${salt}$${scryptSync(secret, Buffer.from(salt, "base64url"), 64).toString("base64url")}`;
}

// Used for unknown usernames so response time does not reveal which ones exist.
export function dummyHash(mode: PasswordMode): string {
  return mode === "client" ? `proof$AAAAAAAAAAAAAAAAAAAAAA$${"0".repeat(64)}` : `scrypt$AAAAAAAAAAAAAAAAAAAAAA$${"A".repeat(86)}`;
}

export function verifyPassword(secret: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  if (kind === "proof") return hash.length === 64 && timingSafeEqual(Buffer.from(sha256(`${salt}:${secret}`)), Buffer.from(hash));
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(secret, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

export function createSession(ctx: Ctx, userId: number): { token: string; maxAge: number } {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(ctx.now().getTime() + SESSION_DAYS * 86400_000).toISOString();
  ctx.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(ctx.now().toISOString());
  ctx.db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)").run(sha256(token), userId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function requireAuth(ctx: Ctx): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) throw new HttpError(401, "Not signed in");
    const row = ctx.db
      .prepare(
        "SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
      )
      .get(sha256(token), ctx.now().toISOString()) as { id: number; username: string; is_admin: number } | undefined;
    if (!row) throw new HttpError(401, "Session expired");
    c.set("user", { id: row.id, username: row.username, is_admin: row.is_admin === 1 });
    await next();
  };
}

export type Role = "owner" | "member";

// Non-members get 404, not 403, so household ids do not leak.
export function roleIn(ctx: Ctx, userId: number, householdId: number): Role {
  const row = ctx.db
    .prepare("SELECT role FROM memberships WHERE user_id = ? AND household_id = ?")
    .get(userId, householdId) as { role: Role } | undefined;
  if (!row) throw new HttpError(404, "Household not found");
  return row.role;
}

export function requireOwner(ctx: Ctx, userId: number, householdId: number): void {
  if (roleIn(ctx, userId, householdId) !== "owner") throw new HttpError(403, "Only household owners can do this");
}

export function rateLimit(max: number, windowMs: number, now: () => Date): MiddlewareHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  return async (c, next) => {
    const key = c.req.path;
    const t = now().getTime();
    const h = hits.get(key);
    if (!h || h.reset <= t) hits.set(key, { n: 1, reset: t + windowMs });
    else if (++h.n > max) throw new HttpError(429, "Too many attempts; try again later");
    await next();
  };
}
