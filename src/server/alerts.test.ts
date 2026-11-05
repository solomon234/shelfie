import assert from "node:assert/strict";
import { test } from "node:test";
import { runAlertCheck } from "./alerts.ts";
import { loginAs, setupInstance, testApp } from "./helpers.test-util.ts";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function harness(start: string, status = 200) {
  const sent: Sent[] = [];
  const state = { now: new Date(start), status };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response("", { status: state.status });
  }) as typeof fetch;
  return { sent, state, opts: { now: () => state.now, fetch: fetchImpl } };
}

async function ready(h: ReturnType<typeof harness>, patch: Record<string, unknown> = { ntfy_url: "https://ntfy.example/shelfie" }) {
  const t = testApp(h.opts);
  const c = t.client();
  await setupInstance(c, { timezone: "UTC" });
  await c.json("PATCH", "/api/households/1", { alert_hour: 8, ...patch });
  const locs = (await c.json("GET", "/api/households/1/locations")).body as { id: number }[];
  const add = (name: string, expires_on: string | null) =>
    c.json("POST", "/api/households/1/lots", { location_id: locs[0]!.id, name, quantity: 1, unit: "item", expires_on });
  return { t, c, add };
}
const ctxOf = (t: ReturnType<typeof testApp>) => (t.app as unknown as { ctx: Parameters<typeof runAlertCheck>[0] }).ctx;

test("nothing is sent without a configured target, and nothing is recorded", async () => {
  const h = harness("2026-11-05T09:00:00Z");
  const { t, add } = await ready(h, {});
  await add("Milk", "2026-11-05");
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 0);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM alert_state").get() as { n: number }).n, 0);
});

test("alerts wait for the household's alert hour and fire once per day", async () => {
  const h = harness("2026-11-05T07:00:00Z");
  const { t, add } = await ready(h);
  await add("Milk", "2026-11-06");
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 0);
  h.state.now = new Date("2026-11-05T08:05:00Z");
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 1);
  h.state.now = new Date("2026-11-05T20:00:00Z");
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 1);
});

test("a lot alerts when it enters the window, again when it expires, and never in between", async () => {
  const h = harness("2026-11-03T09:00:00Z");
  const { t, add } = await ready(h);
  await add("Milk", "2026-11-06"); // 3 days out = inside the default window
  const day = async (iso: string) => {
    h.state.now = new Date(iso);
    await runAlertCheck(ctxOf(t));
  };
  await day("2026-11-03T09:00:00Z");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.body, /Expiring soon: Milk \(1 item\) in 3d/);
  await day("2026-11-04T09:00:00Z");
  await day("2026-11-05T09:00:00Z");
  await day("2026-11-06T09:00:00Z");
  assert.equal(h.sent.length, 1, "no reminders while still in the warning window");
  await day("2026-11-07T09:00:00Z");
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!.body, /Expired: Milk/);
  assert.equal(h.sent[1]!.headers.Priority, "high");
  await day("2026-11-08T09:00:00Z");
  assert.equal(h.sent.length, 2);
});

test("a lot already expired when first seen gets one expired alert", async () => {
  const h = harness("2026-11-05T09:00:00Z");
  const { t, add } = await ready(h);
  await add("Pizza", "2026-10-26");
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.body, /Expired: Pizza/);
  assert.doesNotMatch(h.sent[0]!.body, /Expiring soon/);
});

test("undated and out-of-window lots are ignored; the window is per household", async () => {
  const h = harness("2026-11-05T09:00:00Z");
  const { t, c, add } = await ready(h);
  await add("Rice", null);
  await add("Flour", "2026-12-01");
  await add("Bread", "2026-11-09"); // 4 days out
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 0);
  await c.json("PATCH", "/api/households/1", { expiry_warning_days: 5 });
  t.db.prepare("UPDATE households SET last_alert_on = NULL").run();
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.body, /Bread/);
  assert.doesNotMatch(h.sent[0]!.body, /Flour|Rice/);
});

test("one message lists every new item", async () => {
  const h = harness("2026-11-05T09:00:00Z");
  const { t, add } = await ready(h);
  await add("Milk", "2026-11-05");
  await add("Eggs", "2026-11-06");
  await add("Pizza", "2026-10-30");
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.url, "https://ntfy.example/shelfie");
  assert.match(h.sent[0]!.headers.Title!, /3 items need attention \(Home\)/);
  assert.match(h.sent[0]!.body, /Pizza/);
  assert.match(h.sent[0]!.body, /Milk \(1 item\) today/);
});

test("the alert hour is read in the household's timezone", async () => {
  // 05:00 UTC is 00:00 in New York but 18:00 in Auckland.
  const ny = harness("2026-11-05T05:00:00Z");
  const a = await ready(ny);
  await a.c.json("PATCH", "/api/households/1", { timezone: "America/New_York" });
  await a.add("Milk", "2026-11-05");
  await runAlertCheck(ctxOf(a.t));
  assert.equal(ny.sent.length, 0);

  const nz = harness("2026-11-05T05:00:00Z");
  const b = await ready(nz);
  await b.c.json("PATCH", "/api/households/1", { timezone: "Pacific/Auckland" });
  await b.add("Milk", "2026-11-06"); // Auckland's date is already Nov 5
  await runAlertCheck(ctxOf(b.t));
  assert.equal(nz.sent.length, 1);
});

test("a failed delivery is not recorded and the next run retries", async () => {
  const h = harness("2026-11-05T09:00:00Z", 500);
  const { t, add } = await ready(h);
  await add("Milk", "2026-11-05");
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 1);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM alert_state").get() as { n: number }).n, 0);
  h.state.status = 200;
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 2);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM alert_state").get() as { n: number }).n, 1);
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 2);
});

test("a webhook receives structured JSON", async () => {
  const h = harness("2026-11-05T09:00:00Z");
  const { t, add } = await ready(h, { ntfy_url: null, webhook_url: "https://hooks.example/x" });
  await add("Milk", "2026-11-05");
  await runAlertCheck(ctxOf(t));
  const body = JSON.parse(h.sent[0]!.body);
  assert.equal(body.household, "Home");
  assert.equal(body.warning[0].name, "Milk");
  assert.equal(body.warning[0].days, 0);
  assert.deepEqual(body.expired, []);
});

test("editing a lot's expiry starts a fresh alert cycle", async () => {
  const h = harness("2026-11-05T09:00:00Z");
  const { t, c, add } = await ready(h);
  const lotId = (await add("Milk", "2026-11-06")).body.lot_id;
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 1);
  await c.json("PATCH", `/api/households/1/lots/${lotId}`, { expires_on: "2026-11-07" });
  t.db.prepare("UPDATE households SET last_alert_on = NULL").run();
  await runAlertCheck(ctxOf(t));
  assert.equal(h.sent.length, 2);
});

test("only owners can send a test alert, and it needs a target", async () => {
  const h = harness("2026-11-05T09:00:00Z");
  const { t, c } = await ready(h, {});
  assert.equal((await c.json("POST", "/api/households/1/alerts/test")).status, 400);
  await c.json("PATCH", "/api/households/1", { ntfy_url: "https://ntfy.example/shelfie" });
  const ok = await c.json("POST", "/api/households/1/alerts/test");
  assert.equal(ok.status, 200);
  assert.equal(h.sent.length, 1);
  await c.json("POST", "/api/households/1/members", { username: "alice", password: "alice-pass-1" });
  const alice = await loginAs(t, "alice", "alice-pass-1");
  assert.equal((await alice.json("POST", "/api/households/1/alerts/test")).status, 403);
  assert.equal(h.sent.length, 1);
});
