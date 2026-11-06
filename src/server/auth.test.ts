import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { hashPassword, verifyPassword } from "./auth.ts";
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
  // `auth` only names the password mode ("server" or "client"); nothing here depends on whether setup happened.
  assert.deepEqual(Object.keys(fresh.body).sort(), ["auth", "ok", "version"]);
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

test("client mode stores a salted hash of the browser's proof and logs in with it", async () => {
  const t = testApp({ passwordMode: "client" });
  const c = t.client();
  const proof = "p".repeat(43);
  assert.equal((await c.json("GET", "/api/health")).body.auth, "client");
  assert.equal((await setupInstance(c, { password: proof })).status, 200);
  const u = t.db.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
  assert.ok(u.password_hash.startsWith("proof$"));
  assert.ok(!u.password_hash.includes(proof));

  const ok = t.client();
  assert.equal((await ok.json("POST", "/api/login", { username: "admin", password: proof })).status, 200);
  const bad = t.client();
  assert.equal((await bad.json("POST", "/api/login", { username: "admin", password: "q".repeat(43) })).status, 401);
  assert.equal((await bad.json("POST", "/api/login", { username: "nobody", password: proof })).status, 401);
});

test("an existing scrypt hash still verifies when the server runs in client mode", () => {
  const stored = hashPassword("hunter2hunter2", "server");
  assert.ok(stored.startsWith("scrypt$"));
  assert.ok(verifyPassword("hunter2hunter2", stored));
  assert.ok(!verifyPassword("wrong", stored));
});

for (const mode of ["server", "client"] as const) {
  test(`changing the password (${mode} mode) needs the current one and signs out other devices`, async () => {
    const t = testApp({ passwordMode: mode });
    const secret = (p: string) => (mode === "client" ? p.padEnd(43, "x") : p);
    const c = t.client();
    await setupInstance(c, { password: secret("old-password") });
    const other = await loginAs(t, "admin", secret("old-password"));

    assert.equal((await t.client().json("POST", "/api/me/password", { current_password: secret("old-password"), new_password: secret("new-password") })).status, 401);
    const wrong = await c.json("POST", "/api/me/password", { current_password: secret("not-it-at-all"), new_password: secret("new-password") });
    assert.equal(wrong.status, 403);
    assert.equal((await c.json("POST", "/api/me/password", { current_password: secret("old-password"), new_password: "short" })).status, 400);

    assert.equal((await c.json("POST", "/api/me/password", { current_password: secret("old-password"), new_password: secret("new-password") })).status, 200);
    assert.equal((await c.json("GET", "/api/me")).status, 200); // this device stays signed in
    assert.equal((await other.json("GET", "/api/me")).status, 401); // the other one does not
    assert.equal((await t.client().json("POST", "/api/login", { username: "admin", password: secret("old-password") })).status, 401);
    assert.equal((await t.client().json("POST", "/api/login", { username: "admin", password: secret("new-password") })).status, 200);
  });
}

test("admins create accounts that each get a separate household; others cannot", async () => {
  const t = testApp();
  const admin = t.client();
  await setupInstance(admin);

  const made = await admin.json("POST", "/api/admin/users", { username: "friend", password: "friend-pass-1", household_name: "Friend's shelf", timezone: "America/Chicago" });
  assert.equal(made.status, 201);
  assert.equal((await admin.json("POST", "/api/admin/users", { username: "FRIEND", password: "friend-pass-2" })).status, 409); // names compare without case
  assert.equal((await admin.json("POST", "/api/admin/users", { username: "short", password: "x" })).status, 400);

  const friend = await loginAs(t, "friend", "friend-pass-1");
  const me = await friend.json("GET", "/api/me");
  assert.equal(me.body.households.length, 1);
  assert.equal(me.body.households[0].name, "Friend's shelf");
  assert.equal(me.body.households[0].role, "owner");
  assert.equal(me.body.is_admin, false);
  assert.equal((await friend.json("GET", `/api/households/${made.body.household_id}/locations`)).body.length, 3);

  // The admin is not a member of the new household, and the friend cannot see the admin's.
  const adminHousehold = (await admin.json("GET", "/api/me")).body.households[0].id;
  assert.equal((await admin.json("GET", `/api/households/${made.body.household_id}/locations`)).status, 404);
  assert.equal((await friend.json("GET", `/api/households/${adminHousehold}/locations`)).status, 404);

  assert.equal((await friend.json("GET", "/api/admin/users")).status, 403);
  assert.equal((await friend.json("POST", "/api/admin/users", { username: "third", password: "third-pass-1" })).status, 403);
  assert.equal((await t.client().json("GET", "/api/admin/users")).status, 401);

  const list = (await admin.json("GET", "/api/admin/users")).body;
  assert.deepEqual(list.map((u: { username: string }) => u.username), ["admin", "friend"]);
  assert.deepEqual(list[1].households, [{ name: "Friend's shelf", role: "owner" }]);
});

test("admins can reset another account's password, which signs that account out", async () => {
  const t = testApp();
  const admin = t.client();
  await setupInstance(admin);
  const made = await admin.json("POST", "/api/admin/users", { username: "friend", password: "friend-pass-1" });
  const friend = await loginAs(t, "friend", "friend-pass-1");
  const adminId = (await admin.json("GET", "/api/me")).body.id;

  assert.equal((await friend.json("POST", `/api/admin/users/${made.body.id}/password`, { password: "hacked-pass-1" })).status, 403);
  assert.equal((await admin.json("POST", `/api/admin/users/${adminId}/password`, { password: "another-pass-1" })).status, 400); // own account
  assert.equal((await admin.json("POST", "/api/admin/users/9999/password", { password: "another-pass-1" })).status, 404);
  assert.equal((await admin.json("POST", `/api/admin/users/${made.body.id}/password`, { password: "short" })).status, 400);

  assert.equal((await admin.json("POST", `/api/admin/users/${made.body.id}/password`, { password: "fresh-pass-99" })).status, 200);
  assert.equal((await friend.json("GET", "/api/me")).status, 401);
  assert.equal((await t.client().json("POST", "/api/login", { username: "friend", password: "friend-pass-1" })).status, 401);
  assert.equal((await t.client().json("POST", "/api/login", { username: "friend", password: "fresh-pass-99" })).status, 200);
  assert.equal((await admin.json("GET", "/api/me")).status, 200); // the admin stays signed in
});

test("the admin usage view summarizes each household and is admin-only", async () => {
  const t = testApp();
  const admin = t.client();
  await setupInstance(admin);
  const made = await admin.json("POST", "/api/admin/users", { username: "friend", password: "friend-pass-1", household_name: "Friend's shelf" });
  const friend = await loginAs(t, "friend", "friend-pass-1");
  const loc = (await friend.json("GET", `/api/households/${made.body.household_id}/locations`)).body[0].id;
  await friend.json("POST", `/api/households/${made.body.household_id}/sync`, {
    ops: [
      { type: "lot.add", client_id: "u1", location_id: loc, name: "Rice", quantity: 1 },
      { type: "lot.add", client_id: "u2", location_id: loc, name: "Beans", quantity: 2 },
      { type: "shopping.add", client_id: "u3", name: "Milk" },
    ],
  });

  assert.equal((await friend.json("GET", "/api/admin/usage")).status, 403);
  assert.equal((await t.client().json("GET", "/api/admin/usage")).status, 401);

  const { body } = await admin.json("GET", "/api/admin/usage");
  assert.deepEqual(body.instance, { accounts: 2, households: 2, items: 2, storage_bytes: body.instance.storage_bytes });
  assert.ok(body.instance.storage_bytes > 0);
  const [first, second] = body.households;
  assert.equal(first.name, "Friend's shelf"); // most recent activity first
  assert.deepEqual({ ...first, id: 0, last_change: null }, { id: 0, name: "Friend's shelf", members: 1, items: 2, shopping_open: 1, notification_devices: 0, changes_7d: 3, last_change: null });
  assert.ok(first.last_change);
  assert.equal(second.name, "Home");
  assert.equal(second.items, 0);
  assert.equal(second.last_change, null);
});
