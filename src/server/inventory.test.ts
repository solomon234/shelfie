import assert from "node:assert/strict";
import { test } from "node:test";
import { loginAs, setupInstance, testApp } from "./helpers.test-util.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function ready(opts: Parameters<typeof testApp>[0] = {}) {
  const t = testApp(opts);
  const c = t.client();
  await setupInstance(c);
  const locs = (await c.json("GET", "/api/households/1/locations")).body as { id: number; name: string }[];
  const L = Object.fromEntries(locs.map((l) => [l.name, l.id]));
  return { t, c, L };
}
const lot = (loc: number, extra: Record<string, unknown> = {}) => ({ location_id: loc, name: "Beans", quantity: 2, unit: "can", ...extra });
const productCount = (t: ReturnType<typeof testApp>) => (t.db.prepare("SELECT COUNT(*) n FROM products").get() as { n: number }).n;

test("add a lot by name; names match case-insensitively to one product", async () => {
  const { t, c, L } = await ready();
  assert.equal((await c.json("POST", "/api/households/1/lots", lot(L.Pantry!))).status, 201);
  assert.equal((await c.json("POST", "/api/households/1/lots", lot(L.Pantry!, { name: "  BEANS ", expires_on: "2027-01-01" }))).status, 201);
  assert.equal(productCount(t), 1);
  const inv = (await c.json("GET", "/api/households/1/inventory")).body;
  assert.equal(inv.length, 2);
  assert.equal(inv[0].expires_on, "2027-01-01"); // dated lots sort before undated
  assert.equal(inv[1].expires_on, null);
});

test("two packs of one product with different expiry stay as two lots", async () => {
  const { c, L } = await ready();
  await c.json("POST", "/api/households/1/lots", lot(L.Refrigerator!, { name: "Milk", expires_on: "2026-11-10" }));
  await c.json("POST", "/api/households/1/lots", lot(L.Refrigerator!, { name: "Milk", expires_on: "2026-11-20" }));
  const inv = (await c.json("GET", "/api/households/1/inventory")).body;
  assert.deepEqual(inv.map((l: { expires_on: string }) => l.expires_on), ["2026-11-10", "2026-11-20"]);
});

test("UPC-A and EAN-13 scans resolve to one product, named from Open Food Facts once", async () => {
  let calls = 0;
  const { t, c, L } = await ready({ fetch: (async () => (calls++, json({ status: 1, product: { product_name: "Kleenex", brands: "Kimberly" } }))) as typeof fetch });
  await c.json("POST", "/api/households/1/lots", { location_id: L.Pantry, barcode: "036000291452", quantity: 1 });
  await c.json("POST", "/api/households/1/lots", { location_id: L.Pantry, barcode: "0036000291452", quantity: 1 });
  assert.equal(productCount(t), 1);
  assert.equal(calls, 1);
  const inv = (await c.json("GET", "/api/households/1/inventory")).body;
  assert.equal(inv[0].name, "Kleenex");
  assert.equal(inv[0].barcode, "0036000291452");
});

test("a failed lookup still saves the scan as an unresolved product", async () => {
  const { c, L } = await ready({ fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
  const r = await c.json("POST", "/api/households/1/lots", { location_id: L.Pantry, barcode: "036000291452", quantity: 1, expires_on: "2026-12-01" });
  assert.equal(r.status, 201);
  const inv = (await c.json("GET", "/api/households/1/inventory")).body;
  assert.equal(inv[0].resolved, 0);
  assert.equal(inv[0].name, "0036000291452");
});

test("a later scan resolves a previously unresolved product", async () => {
  let online = false;
  const { c, L } = await ready({ fetch: (async () => { if (!online) throw new Error("offline"); return json({ status: 1, product: { product_name: "Soup" } }); }) as typeof fetch });
  await c.json("POST", "/api/households/1/lots", { location_id: L.Pantry, barcode: "036000291452", quantity: 1 });
  online = true;
  await c.json("POST", "/api/households/1/lots", { location_id: L.Pantry, barcode: "036000291452", quantity: 1 });
  const inv = (await c.json("GET", "/api/households/1/inventory")).body;
  assert.deepEqual(inv.map((l: { name: string; resolved: number }) => [l.name, l.resolved]), [["Soup", 1], ["Soup", 1]]);
});

test("a name supplied with a barcode skips the lookup", async () => {
  let calls = 0;
  const { c, L } = await ready({ fetch: (async () => (calls++, json({ status: 0 }))) as typeof fetch });
  await c.json("POST", "/api/households/1/lots", { location_id: L.Pantry, barcode: "036000291452", name: "My Tissues", quantity: 1 });
  assert.equal(calls, 0);
  assert.equal(((await c.json("GET", "/api/households/1/inventory")).body[0]).name, "My Tissues");
});

test("product lookup endpoint: found, not found, invalid", async () => {
  const { c } = await ready({ fetch: (async (u: string) => (String(u).includes("0036000291452") ? json({ status: 1, product: { product_name: "Kleenex" } }) : json({ status: 0 }))) as typeof fetch });
  assert.deepEqual((await c.json("GET", "/api/products/036000291452")).body, { barcode: "0036000291452", found: true, name: "Kleenex" });
  assert.equal((await c.json("GET", "/api/products/96385074")).body.found, false);
  assert.equal((await c.json("GET", "/api/products/12345")).status, 400);
});

test("adding with the same client_id twice creates one lot", async () => {
  const { t, c, L } = await ready();
  const body = lot(L.Pantry!, { client_id: "c-1" });
  assert.equal((await c.json("POST", "/api/households/1/lots", body)).status, 201);
  const again = await c.json("POST", "/api/households/1/lots", body);
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "duplicate");
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM lots").get() as { n: number }).n, 1);
});

test("validation: bad dates, quantity and locations are 400", async () => {
  const { c, L } = await ready();
  for (const bad of [
    lot(L.Pantry!, { expires_on: "tomorrow" }),
    lot(L.Pantry!, { expires_on: "2026-02-30" }),
    lot(L.Pantry!, { quantity: 0 }),
    lot(L.Pantry!, { quantity: "two" }),
    lot(9999),
    { location_id: L.Pantry, quantity: 1 },
    { location_id: L.Pantry, barcode: "123", quantity: 1 },
  ]) {
    assert.equal((await c.json("POST", "/api/households/1/lots", bad)).status, 400, JSON.stringify(bad));
  }
});

test("a location from another household is rejected", async () => {
  const { t, c } = await ready();
  await c.json("POST", "/api/households", { name: "Cabin" });
  const other = (t.db.prepare("SELECT id FROM locations WHERE household_id = 2 LIMIT 1").get() as { id: number }).id;
  assert.equal((await c.json("POST", "/api/households/1/lots", lot(other))).status, 400);
});

test("consume: partial, exact, over (floored), and replay is idempotent", async () => {
  const { c, L } = await ready();
  const add = async (q: number) => (await c.json("POST", "/api/households/1/lots", lot(L.Pantry!, { quantity: q }))).body.lot_id as number;
  const a = await add(5);
  assert.deepEqual((await c.json("POST", `/api/households/1/lots/${a}/consume`, { amount: 2 })).body, { status: "applied", lot_id: a, removed: false });
  assert.equal((await c.json("GET", "/api/households/1/inventory")).body[0].quantity, 3);

  const r = await c.json("POST", `/api/households/1/lots/${a}/consume`, { amount: 3, client_id: "x1" });
  assert.equal(r.body.removed, true);
  assert.equal((await c.json("GET", "/api/households/1/inventory")).body.length, 0);
  const replay = await c.json("POST", `/api/households/1/lots/${a}/consume`, { amount: 3, client_id: "x1" });
  assert.equal(replay.body.status, "duplicate");

  const b = await add(2);
  const over = await c.json("POST", `/api/households/1/lots/${b}/consume`, { amount: 10 });
  assert.equal(over.body.removed, true);
  assert.equal(over.body.floored, true);
});

test("consuming a lot that is already gone reports gone, not an error", async () => {
  const { c, L } = await ready();
  const a = (await c.json("POST", "/api/households/1/lots", lot(L.Pantry!))).body.lot_id;
  await c.json("DELETE", `/api/households/1/lots/${a}`);
  const r = await c.json("POST", `/api/households/1/lots/${a}/consume`, { amount: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "gone");
});

test("consume does not allow decimals to leave dust behind", async () => {
  const { c, L } = await ready();
  const a = (await c.json("POST", "/api/households/1/lots", lot(L.Pantry!, { quantity: 0.3 }))).body.lot_id;
  await c.json("POST", `/api/households/1/lots/${a}/consume`, { amount: 0.1 });
  await c.json("POST", `/api/households/1/lots/${a}/consume`, { amount: 0.1 });
  const r = await c.json("POST", `/api/households/1/lots/${a}/consume`, { amount: 0.1 });
  assert.equal(r.body.removed, true);
});

test("move, edit and delete a lot", async () => {
  const { c, L } = await ready();
  const a = (await c.json("POST", "/api/households/1/lots", lot(L.Pantry!))).body.lot_id;
  assert.equal((await c.json("POST", `/api/households/1/lots/${a}/move`, { location_id: L.Freezer })).body.status, "applied");
  assert.equal((await c.json("POST", `/api/households/1/lots/${a}/move`, { location_id: 9999 })).status, 400);
  assert.equal((await c.json("PATCH", `/api/households/1/lots/${a}`, { quantity: 7, expires_on: "2027-05-05", notes: "x" })).status, 200);
  const l = (await c.json("GET", "/api/households/1/inventory")).body[0];
  assert.deepEqual([l.location_name, l.quantity, l.expires_on, l.notes], ["Freezer", 7, "2027-05-05", "x"]);
  assert.equal((await c.json("DELETE", `/api/households/1/lots/${a}`)).status, 200);
  assert.equal((await c.json("DELETE", `/api/households/1/lots/${a}`)).status, 404);
});

test("days until expiry use the household's timezone", async () => {
  // 03:30 UTC on Nov 5 is still Nov 4 in New York.
  const { c, L } = await ready({ now: () => new Date("2026-11-05T03:30:00Z") });
  await c.json("POST", "/api/households/1/lots", lot(L.Pantry!, { expires_on: "2026-11-04" }));
  await c.json("POST", "/api/households/1/lots", lot(L.Pantry!, { name: "Old", expires_on: "2026-11-03" }));
  const inv = (await c.json("GET", "/api/households/1/inventory")).body;
  assert.deepEqual(inv.map((l: { name: string; days_until_expiry: number }) => [l.name, l.days_until_expiry]), [["Old", -1], ["Beans", 0]]);
});

test("dashboard counts expired, expiring soon and the shopping list", async () => {
  const { c, L } = await ready({ now: () => new Date("2026-11-05T15:00:00Z") });
  const add = (name: string, expires_on: string | null, quantity = 1) => c.json("POST", "/api/households/1/lots", lot(L.Pantry!, { name, expires_on, quantity }));
  await add("Expired", "2026-11-01", 2);
  await add("Today", "2026-11-05");
  await add("In3", "2026-11-08");
  await add("In6", "2026-11-11");
  await add("In30", "2026-12-05");
  await add("Undated", null);
  await c.json("POST", "/api/households/1/shopping", { name: "Eggs" });
  const d = (await c.json("GET", "/api/households/1/dashboard")).body;
  assert.equal(d.expired, 1);
  assert.equal(d.expiring_soon, 2); // warning window defaults to 3 days
  assert.equal(d.expiring_7_days, 3);
  assert.equal(d.shopping_open, 1);
  assert.equal(d.total_quantity, 7);
  assert.deepEqual(d.expiring.map((l: { name: string }) => l.name), ["Expired", "Today", "In3", "In6"]);
});

test("another household's data is invisible and unwritable", async () => {
  const { t, c, L } = await ready();
  await c.json("POST", "/api/households", { name: "Cabin" });
  await c.json("POST", "/api/households/2/members", { username: "bob", password: "bob-pass-123" });
  const bob = await loginAs(t, "bob", "bob-pass-123");
  const a = (await c.json("POST", "/api/households/1/lots", lot(L.Pantry!))).body.lot_id;
  for (const [m, p, b] of [
    ["GET", "/api/households/1/inventory"],
    ["GET", "/api/households/1/dashboard"],
    ["GET", "/api/households/1/shopping"],
    ["POST", "/api/households/1/lots", lot(L.Pantry!)],
    ["POST", `/api/households/1/lots/${a}/consume`, { amount: 1 }],
    ["DELETE", `/api/households/1/lots/${a}`],
  ] as const) assert.equal((await bob.json(m, p, b)).status, 404, `${m} ${p}`);
  // A lot id from household 1 cannot be reached through household 2's URL either.
  assert.equal((await bob.json("POST", `/api/households/2/lots/${a}/consume`, { amount: 1 })).body.status, "gone");
  assert.equal((await c.json("GET", "/api/households/1/inventory")).body.length, 1);
});

test("shopping list: add, idempotent add, toggle, delete, and add from a lot", async () => {
  const { c, L } = await ready();
  assert.equal((await c.json("POST", "/api/households/1/shopping", { name: "Eggs", quantity: 12, client_id: "s1" })).status, 201);
  assert.equal((await c.json("POST", "/api/households/1/shopping", { name: "Eggs", quantity: 12, client_id: "s1" })).body.status, "duplicate");
  let list = (await c.json("GET", "/api/households/1/shopping")).body;
  assert.equal(list.length, 1);
  await c.json("POST", `/api/households/1/shopping/${list[0].id}/toggle`, {});
  list = (await c.json("GET", "/api/households/1/shopping")).body;
  assert.equal(list[0].checked, 1);

  const a = (await c.json("POST", "/api/households/1/lots", lot(L.Pantry!, { name: "Rice" }))).body.lot_id;
  assert.equal((await c.json("POST", `/api/households/1/lots/${a}/shopping`)).body.added, true);
  assert.equal((await c.json("POST", `/api/households/1/lots/${a}/shopping`)).body.added, false);
  list = (await c.json("GET", "/api/households/1/shopping")).body;
  const rice = list.find((i: { name: string }) => i.name === "Rice");
  assert.equal(rice.quantity, 2);
  assert.equal((await c.json("DELETE", `/api/households/1/shopping/${rice.id}`)).status, 200);
  assert.equal((await c.json("DELETE", `/api/households/1/shopping/${rice.id}`)).status, 404);
});
