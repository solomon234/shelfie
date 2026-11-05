import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runAlertCheck } from "./alerts.ts";
import type { PushTarget } from "./context.ts";
import { migrate, openDb } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";
import { isPushEndpoint, vapidKeys } from "./push.ts";
import { loginAs, setupInstance, testApp } from "./helpers.test-util.ts";

const EP = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${n}`;
const sub = (n: number) => ({ endpoint: EP(n), keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } });

interface Pushed {
  target: PushTarget;
  payload: { title: string; body: string; tag: string; url: string };
}

function harness(start = "2026-11-05T09:00:00Z") {
  const pushed: Pushed[] = [];
  const state = { now: new Date(start), result: "ok" as "ok" | "gone" | "error", gone: new Set<string>() };
  const sendPush = async (target: PushTarget, payload: string) => {
    pushed.push({ target, payload: JSON.parse(payload) });
    return state.gone.has(target.endpoint) ? ("gone" as const) : state.result;
  };
  return { pushed, state, opts: { now: () => state.now, sendPush } };
}
const ctxOf = (t: ReturnType<typeof testApp>) => (t.app as unknown as { ctx: Parameters<typeof runAlertCheck>[0] }).ctx;

async function ready(h = harness()) {
  const t = testApp(h.opts as never);
  const c = t.client();
  await setupInstance(c, { timezone: "UTC" });
  await c.json("PATCH", "/api/households/1", { alert_hour: 8 });
  const locs = (await c.json("GET", "/api/households/1/locations")).body as { id: number }[];
  const add = (name: string, expires_on: string) => c.json("POST", "/api/households/1/lots", { location_id: locs[0]!.id, name, quantity: 1, unit: "item", expires_on });
  return { h, t, c, add };
}

test("only real push-service endpoints are accepted", () => {
  for (const ok of [EP(1), "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/abc", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
    assert.equal(isPushEndpoint(ok), true, ok);
  }
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/x",
    "https://192.168.1.11/hook",
    "https://localhost/x",
    "https://evil.example/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.example/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "not a url",
  ]) {
    assert.equal(isPushEndpoint(bad), false, bad);
  }
});

test("the VAPID key pair is created once and survives restarts", () => {
  const db = openDb(":memory:");
  const a = vapidKeys(db);
  assert.ok(a.publicKey.length > 60 && a.privateKey.length > 20);
  assert.deepEqual(vapidKeys(db), a);
});

test("migration 2 upgrades an existing v1 database without losing data", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, [MIGRATIONS[0]!]);
  db.prepare("INSERT INTO households(name) VALUES ('Keep')").run();
  migrate(db);
  assert.equal((db.prepare("SELECT name FROM households").get() as { name: string }).name, "Keep");
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
  db.prepare("SELECT * FROM push_subscriptions").all();
});

test("key endpoint needs sign-in and returns the stable public key", async () => {
  const { t, c } = await ready();
  assert.equal((await t.client().json("GET", "/api/push/key")).status, 401);
  const a = (await c.json("GET", "/api/push/key")).body.public_key;
  const b = (await c.json("GET", "/api/push/key")).body.public_key;
  assert.equal(a, b);
  assert.equal(a, vapidKeys(t.db).publicKey);
});

test("subscribe validates input, upserts by endpoint, and unsubscribe removes only your own", async () => {
  const { t, c } = await ready();
  assert.equal((await c.json("POST", "/api/push/subscribe", { endpoint: "https://192.168.1.11/x", keys: { p256dh: "a", auth: "b" } })).status, 400);
  assert.equal((await c.json("POST", "/api/push/subscribe", { endpoint: EP(1) })).status, 400);
  assert.equal((await c.json("POST", "/api/push/subscribe", sub(1))).status, 200);
  assert.equal((await c.json("POST", "/api/push/subscribe", { ...sub(1), keys: { p256dh: "new", auth: "new" } })).status, 200);
  const rows = t.db.prepare("SELECT p256dh FROM push_subscriptions").all() as { p256dh: string }[];
  assert.deepEqual(rows.map((r) => r.p256dh), ["new"]);

  await c.json("POST", "/api/households/1/members", { username: "alice", password: "alice-pass-1" });
  const alice = await loginAs(t, "alice", "alice-pass-1");
  await alice.json("POST", "/api/push/unsubscribe", { endpoint: EP(1) });
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM push_subscriptions").get() as { n: number }).n, 1, "another user cannot remove it");
  await c.json("POST", "/api/push/unsubscribe", { endpoint: EP(1) });
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM push_subscriptions").get() as { n: number }).n, 0);
});

test("the test push goes only to the caller's devices", async () => {
  const { h, t, c } = await ready();
  assert.equal((await c.json("POST", "/api/push/test")).status, 400);
  await c.json("POST", "/api/push/subscribe", sub(1));
  await c.json("POST", "/api/households/1/members", { username: "alice", password: "alice-pass-1" });
  const alice = await loginAs(t, "alice", "alice-pass-1");
  await alice.json("POST", "/api/push/subscribe", sub(2));
  const r = await c.json("POST", "/api/push/test");
  assert.equal(r.status, 200);
  assert.deepEqual(h.pushed.map((p) => p.target.endpoint), [EP(1)]);
  assert.match(h.pushed[0]!.payload.title, /test/i);
});

test("expiry alerts reach every member's subscribed device, with no ntfy or webhook configured", async () => {
  const { h, t, c, add } = await ready();
  await c.json("POST", "/api/push/subscribe", sub(1));
  await c.json("POST", "/api/households/1/members", { username: "alice", password: "alice-pass-1" });
  const alice = await loginAs(t, "alice", "alice-pass-1");
  await alice.json("POST", "/api/push/subscribe", sub(2));
  await add("Milk", "2026-11-05");
  await add("Pizza", "2026-10-30");
  await runAlertCheck(ctxOf(t));
  assert.deepEqual(h.pushed.map((p) => p.target.endpoint).sort(), [EP(1), EP(2)]);
  const p = h.pushed[0]!.payload;
  assert.match(p.title, /2 items need attention \(Home\)/);
  assert.match(p.body, /Expired: Pizza/);
  assert.match(p.body, /Milk \(1 item\) today/);
  assert.equal(p.url, "/");

  await runAlertCheck(ctxOf(t));
  assert.equal(h.pushed.length, 2, "no repeat for the same transitions");
});

test("a household's alerts never reach another household's devices", async () => {
  const { h, t, c, add } = await ready();
  await c.json("POST", "/api/households", { name: "Cabin" });
  await c.json("POST", "/api/households/2/members", { username: "bob", password: "bob-pass-123" });
  const bob = await loginAs(t, "bob", "bob-pass-123");
  await bob.json("POST", "/api/push/subscribe", sub(9));
  await add("Milk", "2026-11-05");
  await runAlertCheck(ctxOf(t));
  assert.equal(h.pushed.some((p) => p.target.endpoint === EP(9)), false);
});

test("a subscription the push service reports gone is deleted", async () => {
  const { h, t, c, add } = await ready();
  await c.json("POST", "/api/push/subscribe", sub(1));
  await c.json("POST", "/api/push/subscribe", sub(2));
  h.state.gone.add(EP(1));
  await add("Milk", "2026-11-05");
  await runAlertCheck(ctxOf(t));
  const left = (t.db.prepare("SELECT endpoint FROM push_subscriptions").all() as { endpoint: string }[]).map((r) => r.endpoint);
  assert.deepEqual(left, [EP(2)]);
});

test("a failed push is not recorded as delivered and is retried", async () => {
  const { h, t, c, add } = await ready();
  await c.json("POST", "/api/push/subscribe", sub(1));
  await add("Milk", "2026-11-05");
  h.state.result = "error";
  await runAlertCheck(ctxOf(t));
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM alert_state").get() as { n: number }).n, 0);
  h.state.result = "ok";
  await runAlertCheck(ctxOf(t));
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM alert_state").get() as { n: number }).n, 1);
  assert.equal(h.pushed.length, 2);
});

test("the owner's household test alert includes push devices", async () => {
  const { h, c } = await ready();
  assert.equal((await c.json("POST", "/api/households/1/alerts/test")).status, 400);
  await c.json("POST", "/api/push/subscribe", sub(1));
  const r = await c.json("POST", "/api/households/1/alerts/test");
  assert.equal(r.status, 200);
  assert.equal(h.pushed.length, 1);
});

test("deleting a user removes their devices", async () => {
  const { t, c } = await ready();
  await c.json("POST", "/api/push/subscribe", sub(1));
  t.db.prepare("DELETE FROM users").run();
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM push_subscriptions").get() as { n: number }).n, 0);
});

test("the real sender builds a signed, encrypted request for a genuine subscription", async () => {
  const { createECDH, randomBytes } = await import("node:crypto");
  const { default: webpush } = await import("web-push");
  const device = createECDH("prime256v1");
  device.generateKeys();
  const subscription = {
    endpoint: EP(1),
    keys: { p256dh: device.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
  const keys = vapidKeys(openDb(":memory:"));
  const payload = JSON.stringify({ title: "Shelfie", body: "Milk expires today", tag: "t", url: "/" });
  const req = webpush.generateRequestDetails(subscription, payload, {
    vapidDetails: { subject: "mailto:admin@shelfie.local", publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 86400,
    urgency: "high",
  });
  assert.equal(req.endpoint, EP(1));
  assert.equal(req.method, "POST");
  assert.match(req.headers.Authorization!, /^vapid t=.+, k=.+$/);
  assert.equal(req.headers["Content-Encoding"], "aes128gcm");
  assert.equal(String(req.headers.TTL), "86400");
  assert.equal(req.headers.Urgency, "high");
  assert.ok(Buffer.isBuffer(req.body) && req.body.length > payload.length, "body is encrypted ciphertext");
  assert.ok(!req.body.toString("utf8").includes("Milk"));
});
