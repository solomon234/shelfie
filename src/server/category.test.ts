import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runAlertCheck } from "./alerts.ts";
import { migrate } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";
import { CATEGORIES, CATEGORY_INFO, isCategory } from "../shared/categories.ts";
import { setupInstance, testApp } from "./helpers.test-util.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function ready(opts: Parameters<typeof testApp>[0] = {}) {
  const t = testApp(opts);
  const c = t.client();
  await setupInstance(c, { timezone: "UTC" });
  const locs = (await c.json("GET", "/api/households/1/locations")).body as { id: number; name: string }[];
  const L = Object.fromEntries(locs.map((l) => [l.name, l.id]));
  const add = (extra: Record<string, unknown>) => c.json("POST", "/api/households/1/lots", { location_id: L.Pantry, quantity: 1, unit: "item", ...extra });
  const inventory = async () => (await c.json("GET", "/api/households/1/inventory")).body as Record<string, any>[];
  return { t, c, L, add, inventory };
}

test("every category has a label, a date label and presets, and the list is the four we agreed", () => {
  assert.deepEqual([...CATEGORIES], ["food", "medicine", "gear", "household"]);
  for (const c of CATEGORIES) {
    const i = CATEGORY_INFO[c];
    assert.ok(i.label && i.dateLabel && i.presets.length >= 4, c);
  }
  assert.equal(CATEGORY_INFO.gear.dateLabel, "Replace by");
  assert.equal(CATEGORY_INFO.gear.consumable, false);
  assert.equal(CATEGORY_INFO.food.consumable, true);
  assert.equal(isCategory("gear"), true);
  assert.equal(isCategory("camping"), false);
});

test("migration 3 adds the column, defaults existing products to food, and rejects bad values", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, 2));
  db.prepare("INSERT INTO products(name,name_key) VALUES ('Old milk','old milk')").run();
  migrate(db);
  assert.equal((db.prepare("SELECT category FROM products").get() as { category: string }).category, "food");
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
  assert.throws(() => db.prepare("INSERT INTO products(name,name_key,category) VALUES ('x','x','camping')").run());
});

test("a lot defaults to food and keeps an explicit category", async () => {
  const { add, inventory } = await ready();
  await add({ name: "Rice" });
  await add({ name: "Headlamp", category: "gear", expires_on: "2028-01-01" });
  await add({ name: "Ibuprofen", category: "medicine" });
  const cat = Object.fromEntries((await inventory()).map((l) => [l.name, l.category]));
  assert.deepEqual(cat, { Rice: "food", Headlamp: "gear", Ibuprofen: "medicine" });
});

test("an invalid category is rejected and nothing is created", async () => {
  const { t, add } = await ready();
  assert.equal((await add({ name: "Tent", category: "camping" })).status, 400);
  assert.equal((await add({ name: "Tent", category: 5 })).status, 400);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM lots").get() as { n: number }).n, 0);
});

test("the category belongs to the product: the next add and a rescan pick it up", async () => {
  const lookup = (async () => json({ status: 0 })) as typeof fetch;
  const { c, add, inventory } = await ready({ fetch: lookup });
  await add({ barcode: "036000291452", name: "AA batteries", category: "gear" });
  // Same product again with no category keeps gear.
  await add({ barcode: "036000291452", quantity: 4 });
  assert.deepEqual((await inventory()).map((l) => l.category), ["gear", "gear"]);
  // The scan lookup returns it so the form can pre-select it.
  const p = (await c.json("GET", "/api/products/036000291452")).body;
  assert.equal(p.category, "gear");
  // Re-categorising on a later add updates the product, and so every lot of it.
  await add({ barcode: "036000291452", category: "household" });
  assert.deepEqual((await inventory()).map((l) => l.category), ["household", "household", "household"]);
});

test("a name-only product is matched case-insensitively and shares its category", async () => {
  const { add, inventory } = await ready();
  await add({ name: "Water", category: "household" });
  await add({ name: "  WATER " });
  assert.deepEqual((await inventory()).map((l) => l.category), ["household", "household"]);
});

test("the category can be changed from the lot, with or without other edits", async () => {
  const { c, add, inventory } = await ready();
  const id = (await add({ name: "Flashlight" })).body.lot_id;
  assert.equal((await c.json("PATCH", `/api/households/1/lots/${id}`, { category: "gear" })).status, 200);
  assert.equal((await inventory())[0]!.category, "gear");
  assert.equal((await c.json("PATCH", `/api/households/1/lots/${id}`, { category: "gear", notes: "kitchen drawer" })).status, 200);
  assert.equal((await c.json("PATCH", `/api/households/1/lots/${id}`, { category: "tent" })).status, 400);
  assert.equal((await c.json("PATCH", `/api/households/1/lots/${id}`, {})).status, 400);
  assert.equal((await c.json("PATCH", "/api/households/1/lots/9999", { category: "gear" })).status, 404);
});

test("an offline add synced later keeps the category", async () => {
  const { c, L, inventory } = await ready();
  const r = await c.json("POST", "/api/households/1/sync", {
    ops: [{ type: "lot.add", client_id: "g1", location_id: L.Pantry, name: "Water filter", quantity: 2, category: "gear", expires_on: "2027-06-01" }],
  });
  assert.equal(r.body.results[0].status, "applied");
  const inv = await inventory();
  assert.deepEqual([inv[0]!.name, inv[0]!.category], ["Water filter", "gear"]);
  const bad = await c.json("POST", "/api/households/1/sync", { ops: [{ type: "lot.add", client_id: "g2", location_id: L.Pantry, name: "X", quantity: 1, category: "camping" }] });
  assert.equal(bad.body.results[0].status, "invalid");
});

test("gear alerts like any other lot and the webhook says what category it is", async () => {
  const sent: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => (sent.push({ url: String(url), body: String(init.body) }), new Response("", { status: 200 }))) as typeof fetch;
  const { t, c, add } = await ready({ now: () => new Date("2026-11-05T09:00:00Z"), fetch: fetchImpl });
  await c.json("PATCH", "/api/households/1", { alert_hour: 8, webhook_url: "https://hooks.example/x" });
  await add({ name: "Fire extinguisher", category: "gear", expires_on: "2026-11-06" });
  await runAlertCheck((t.app as unknown as { ctx: Parameters<typeof runAlertCheck>[0] }).ctx);
  const body = JSON.parse(sent.find((s) => s.url === "https://hooks.example/x")!.body);
  assert.equal(body.warning[0].name, "Fire extinguisher");
  assert.equal(body.warning[0].category, "gear");
});
