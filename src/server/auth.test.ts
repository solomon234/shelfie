import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { TOKEN, client, loginAs, setupInstance, testApp } from "./helpers.test-util.ts";

test("setup needs the token: missing, wrong, or unset on the server", async () => {
  const t = testApp();
  const c = t.client();
  assert.equal((await c.json("POST", "/api/setup", { username: "a1", password: "password1", household_name: "H" })).status, 403);
  assert.equal((await setupInstance(c, { token: "wrong" })).status, 403);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n, 0);

  const noToken = client(createApp(openDb(":memory:")));
  assert.equal((await setupInstance(noToken)).status, 503);
});

test("setup creates the admin once and never again", async () => {
  const t = testApp();
  const c = t.client();
  const r = await setupInstance(c);
  assert.equal(r.status, 200);
  assert.ok(c.cookie.startsWith("shelfie_session="));
  const me = await c.json("GET", "/api/me");
  assert.equal(me.body.username, "admin");
  assert.equal(me.body.is_admin, true);
  assert.equal(me.body.households[0].role, "owner");
  assert.equal(me.body.households[0].timezone, "America/New_York");
  assert.equal((await t.client().json("GET", "/api/households/1/locations")).status, 401);

  const again = await setupInstance(t.client(), { username: "other" });
  assert.equal(again.status, 409);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n, 1);

  const locs = await c.json("GET", "/api/households/1/locations");
  assert.deepEqual(locs.body.map((l: { name: string }) => l.name), ["Pantry", "Refrigerator", "Freezer"]);
});

test("the public surface does not reveal whether setup is pending", async () => {
  const fresh = await testApp().client().json("GET", "/api/health");
  assert.deepEqual(Object.keys(fresh.body).sort(), ["ok", "version"]);
});

test("passwords and session tokens are stored hashed", async () => {
  const t = testApp();
  const c = t.client();
  await setupInstance(c);
  const u = t.db.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
  assert.ok(u.password_hash.startsWith("scrypt$"));
  assert.ok(!u.password_hash.includes("correct horse"));
  const token = c.cookie.split("=")[1]!;
  const s = t.db.prepare("SELECT token_hash FROM sessions").get() as { token_hash: string };
  assert.notEqual(s.token_hash, token);
});

test("login accepts good credentials and rejects bad ones the same way", async () => {
  const t = testApp();
  await setupInstance(t.client());
  const good = t.client();
  assert.equal((await good.json("POST", "/api/login", { username: "ADMIN", password: "correct horse" })).status, 200);
  const badPw = await t.client().json("POST", "/api/login", { username: "admin", password: "nope" });
  const badUser = await t.client().json("POST", "/api/login", { username: "ghost", password: "nope" });
  assert.equal(badPw.status, 401);
  assert.deepEqual(badPw.body, badUser.body);
});

test("logout invalidates the session server-side", async () => {
  const t = testApp();
  const c = t.client();
  await setupInstance(c);
  const stolen = c.cookie;
  await c.json("POST", "/api/logout");
  const replay = t.client();
  replay.cookie = stolen;
  assert.equal((await replay.json("GET", "/api/me")).status, 401);
});

test("sessions expire after 30 days", async () => {
  let now = new Date("2026-11-05T12:00:00Z");
  const t = testApp({ now: () => now });
  const c = t.client();
  await setupInstance(c);
  assert.equal((await c.json("GET", "/api/me")).status, 200);
  now = new Date("2026-12-06T12:00:00Z");
  assert.equal((await c.json("GET", "/api/me")).status, 401);
});

test("login is rate limited", async () => {
  const t = testApp();
  await setupInstance(t.client());
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await t.client().json("POST", "/api/login", { username: "admin", password: "bad" + i })).status;
  assert.equal(last, 429);
});

test("households are isolated: other users get 404 and cannot change settings", async () => {
  const t = testApp();
  const admin = t.client();
  await setupInstance(admin);
  await admin.json("POST", "/api/households", { name: "Cabin" }); // household 2, admin owns both
  await admin.json("POST", "/api/households/1/members", { username: "alice", password: "alice-pass-1" });
  await admin.json("POST", "/api/households/2/members", { username: "bob", password: "bob-pass-123" });
  const alice = await loginAs(t, "alice", "alice-pass-1");
  const bob = await loginAs(t, "bob", "bob-pass-123");

  assert.equal((await alice.json("GET", "/api/households/1/locations")).status, 200);
  assert.equal((await alice.json("GET", "/api/households/2/locations")).status, 404);
  assert.equal((await bob.json("GET", "/api/households/1/locations")).status, 404);
  assert.equal((await bob.json("PATCH", "/api/households/1", { name: "Hijack" })).status, 404);
  assert.equal((t.db.prepare("SELECT name FROM households WHERE id = 1").get() as { name: string }).name, "Home");
});

test("members cannot manage the household; owners can", async () => {
  const t = testApp();
  const admin = t.client();
  await setupInstance(admin);
  await admin.json("POST", "/api/households/1/members", { username: "alice", password: "alice-pass-1" });
  const alice = await loginAs(t, "alice", "alice-pass-1");

  assert.equal((await alice.json("PATCH", "/api/households/1", { expiry_warning_days: 5 })).status, 403);
  assert.equal((await alice.json("POST", "/api/households/1/members", { username: "carl", password: "carl-pass-12" })).status, 403);
  assert.equal((await alice.json("GET", "/api/households/1/members")).status, 403);
  assert.equal((await alice.json("POST", "/api/households", { name: "Mine" })).status, 403);

  const mine = (await alice.json("GET", "/api/me")).body.households[0];
  assert.equal(mine.ntfy_url, null); // members never see alert targets

  const ok = await admin.json("PATCH", "/api/households/1", {
    expiry_warning_days: 5,
    alert_hour: 7,
    timezone: "Europe/London",
    ntfy_url: "https://ntfy.sh/shelfie-test",
  });
  assert.equal(ok.status, 200);
  const h = (await admin.json("GET", "/api/me")).body.households[0];
  assert.equal(h.expiry_warning_days, 5);
  assert.equal(h.alert_hour, 7);
  assert.equal(h.timezone, "Europe/London");
  assert.equal(h.ntfy_url, "https://ntfy.sh/shelfie-test");
});

test("household settings are validated", async () => {
  const t = testApp();
  const admin = t.client();
  await setupInstance(admin);
  for (const bad of [
    { timezone: "Mars/Olympus" },
    { alert_hour: 24 },
    { expiry_warning_days: -1 },
    { expiry_warning_days: 1.5 },
    { ntfy_url: "ftp://example.com" },
    { webhook_url: "not a url" },
  ]) {
    assert.equal((await admin.json("PATCH", "/api/households/1", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin.json("PATCH", "/api/households/1", {})).status, 400);
});

test("the last owner cannot be removed", async () => {
  const t = testApp();
  const admin = t.client();
  await setupInstance(admin);
  const adminId = (await admin.json("GET", "/api/me")).body.id;
  assert.equal((await admin.json("DELETE", `/api/households/1/members/${adminId}`)).status, 409);
  await admin.json("POST", "/api/households/1/members", { username: "alice", password: "alice-pass-1", role: "owner" });
  assert.equal((await admin.json("DELETE", `/api/households/1/members/${adminId}`)).status, 200);
});

test("cross-origin writes are blocked", async () => {
  const t = testApp();
  const c = t.client();
  const res = await c.req("POST", "/api/login", { username: "a", password: "b" }, { origin: "https://evil.example", host: "shelfie.local" });
  assert.equal(res.status, 403);
  const same = await c.req("POST", "/api/login", { username: "a", password: "b" }, { origin: "https://shelfie.local", host: "shelfie.local" });
  assert.equal(same.status, 401);
});

test("malformed bodies are 400, not 500", async () => {
  const t = testApp();
  const res = await t.app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(res.status, 400);
});
