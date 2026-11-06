import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pruneAppliedOps, runAlertCheck } from "./alerts.ts";
import { migrate, NodeDb } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";
import { CATEGORIES, CATEGORY_INFO, isCategory } from "../shared/categories.ts";
import { loginAs, setupInstance, testApp } from "./helpers.test-util.ts";

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
  const db = new NodeDb(new DatabaseSync(":memory:"));
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
  const p = (await c.json("GET", "/api/products/036000291452?household=1")).body;
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

test("migration 4 gives each household the category it sees today and resets the shared catalog to food", () => {
  const db = new NodeDb(new DatabaseSync(":memory:"));
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, 3));
  const h = (n: string) => Number(db.prepare("INSERT INTO households(name) VALUES (?)").run(n).lastInsertRowid);
  const [a, b, c] = [h("A"), h("B"), h("C")];
  const loc = (hid: number) => Number(db.prepare("INSERT INTO locations(household_id,name) VALUES (?,'Pantry')").run(hid).lastInsertRowid);
  const med = Number(db.prepare("INSERT INTO products(name,name_key,category) VALUES ('Aspirin','aspirin','medicine')").run().lastInsertRowid);
  const rice = Number(db.prepare("INSERT INTO products(name,name_key) VALUES ('Rice','rice')").run().lastInsertRowid);
  for (const hid of [a, b]) db.prepare("INSERT INTO lots(household_id,location_id,product_id,quantity) VALUES (?,?,?,1)").run(hid, loc(hid), med);
  db.prepare("INSERT INTO lots(household_id,location_id,product_id,quantity) VALUES (?,?,?,1)").run(c, loc(c), rice);

  migrate(db);
  const rows = db.prepare("SELECT household_id, category FROM household_product_categories ORDER BY household_id").all().map((r) => ({ ...(r as object) }));
  assert.deepEqual(rows, [{ household_id: a, category: "medicine" }, { household_id: b, category: "medicine" }]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM products WHERE category <> 'food'").get() as { n: number }).n, 0);
});

test("one household's category choice never reaches another household", async () => {
  const lookup = (async () => json({ status: 0 })) as typeof fetch;
  const t = testApp({ fetch: lookup });
  const admin = t.client();
  await setupInstance(admin, { timezone: "UTC" });
  const made = await admin.json("POST", "/api/admin/users", { username: "friend", password: "friend-pass-1", household_name: "Friend" });
  const friend = await loginAs(t, "friend", "friend-pass-1");
  const addTo = (cl: typeof admin, hid: number, extra: Record<string, unknown>) =>
    cl.json("POST", `/api/households/${hid}/lots`, { location_id: undefined, quantity: 1, unit: "item", ...extra });
  const loc = async (cl: typeof admin, hid: number) => (await cl.json("GET", `/api/households/${hid}/locations`)).body[0].id as number;
  const adminLoc = await loc(admin, 1);
  const friendLoc = await loc(friend, made.body.household_id);
  const fid = made.body.household_id as number;

  // Same manual name and same barcode in both households.
  await addTo(admin, 1, { location_id: adminLoc, name: "Water", category: "household" });
  await addTo(friend, fid, { location_id: friendLoc, name: "water" });
  await addTo(admin, 1, { location_id: adminLoc, barcode: "036000291452", name: "AA batteries", category: "gear" });
  await addTo(friend, fid, { location_id: friendLoc, barcode: "036000291452" });

  const cats = async (cl: typeof admin, hid: number) =>
    Object.fromEntries(((await cl.json("GET", `/api/households/${hid}/inventory`)).body as { name: string; category: string }[]).map((l) => [l.name.toLowerCase(), l.category]));
  assert.deepEqual(await cats(admin, 1), { water: "household", "aa batteries": "gear" });
  assert.deepEqual(await cats(friend, fid), { water: "food", "aa batteries": "food" });

  // Recategorizing in one household from the lot does not move the other.
  const lot = ((await friend.json("GET", `/api/households/${fid}/inventory`)).body as { id: number; name: string }[]).find((l) => l.name.toLowerCase() === "water")!;
  assert.equal((await friend.json("PATCH", `/api/households/${fid}/lots/${lot.id}`, { category: "gear" })).status, 200);
  assert.equal((await cats(friend, fid)).water, "gear");
  assert.equal((await cats(admin, 1)).water, "household");

  // The scan lookup is scoped too, and refuses a household the caller does not belong to.
  assert.equal((await admin.json("GET", "/api/products/036000291452?household=1")).body.category, "gear");
  assert.equal((await friend.json("GET", `/api/products/036000291452?household=${fid}`)).body.category, "food");
  assert.equal((await friend.json("GET", "/api/products/036000291452?household=1")).status, 404);
  assert.equal((await friend.json("GET", "/api/products/036000291452")).body.category, "food");
});

test("applied-op records older than 30 days are pruned, once a day", async () => {
  let now = new Date("2026-11-06T12:00:00Z");
  const t = testApp({ now: () => now });
  await setupInstance(t.client(), { timezone: "UTC" });
  const ctx = t.app.ctx;
  const op = (id: string, at: string) => ctx.db.prepare("INSERT INTO applied_ops(household_id,client_id,op,result,created_at) VALUES (1,?,'lot.add','{}',?)").run(id, at);
  const left = () => (ctx.db.prepare("SELECT client_id FROM applied_ops ORDER BY client_id").all() as { client_id: string }[]).map((r) => r.client_id);
  op("old", "2026-10-01T00:00:00Z");
  op("edge", "2026-10-08T00:00:00Z"); // 29 days old
  op("new", "2026-11-05T00:00:00Z");

  assert.equal(pruneAppliedOps(ctx), 1);
  assert.deepEqual(left(), ["edge", "new"]);

  op("old2", "2026-09-01T00:00:00Z");
  assert.equal(pruneAppliedOps(ctx), 0); // already ran today
  assert.deepEqual(left(), ["edge", "new", "old2"]);

  now = new Date("2026-11-07T12:00:00Z"); // next day: "edge" is now past 30 days too
  assert.equal(pruneAppliedOps(ctx), 2);
  assert.deepEqual(left(), ["new"]);
});
