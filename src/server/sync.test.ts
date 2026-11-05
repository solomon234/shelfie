import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePendingProducts } from "./barcode.ts";
import { loginAs, setupInstance, testApp } from "./helpers.test-util.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function ready(opts: Parameters<typeof testApp>[0] = {}) {
  const t = testApp(opts);
  const c = t.client();
  await setupInstance(c);
  const locs = (await c.json("GET", "/api/households/1/locations")).body as { id: number; name: string }[];
  const L = Object.fromEntries(locs.map((l) => [l.name, l.id]));
  const sync = (ops: unknown[]) => c.json("POST", "/api/households/1/sync", { ops });
  return { t, c, L, sync };
}
const statuses = (r: { body: { results: { status: string }[] } }) => r.body.results.map((x) => x.status);

test("a batch applies in order, including ops on lots created earlier in the same batch", async () => {
  const { c, L, sync } = await ready();
  const r = await sync([
    { type: "lot.add", client_id: "a1", location_id: L.Pantry, name: "Beans", quantity: 3, unit: "can", expires_on: "2027-01-01" },
    { type: "lot.add", client_id: "a2", location_id: L.Refrigerator, name: "Milk", quantity: 1, unit: "L", expires_on: "2026-11-10" },
    { type: "lot.consume", client_id: "a3", lot_client_id: "a1", amount: 1 },
    { type: "lot.move", client_id: "a4", lot_client_id: "a2", location_id: L.Freezer },
    { type: "shopping.add", client_id: "a5", name: "Eggs", quantity: 12 },
  ]);
  assert.equal(r.status, 200);
  assert.deepEqual(statuses(r), ["applied", "applied", "applied", "applied", "applied"]);
  const inv = (await c.json("GET", "/api/households/1/inventory")).body;
  const beans = inv.find((l: { name: string }) => l.name === "Beans");
  const milk = inv.find((l: { name: string }) => l.name === "Milk");
  assert.equal(beans.quantity, 2);
  assert.equal(milk.location_name, "Freezer");
  assert.equal((await c.json("GET", "/api/households/1/shopping")).body.length, 1);
});

test("replaying the same batch changes nothing and reports duplicates", async () => {
  const { t, c, L, sync } = await ready();
  const ops = [
    { type: "lot.add", client_id: "b1", location_id: L.Pantry, name: "Beans", quantity: 3 },
    { type: "lot.consume", client_id: "b2", lot_client_id: "b1", amount: 1 },
    { type: "shopping.add", client_id: "b3", name: "Eggs" },
  ];
  await sync(ops);
  const again = await sync(ops);
  assert.deepEqual(statuses(again), ["duplicate", "duplicate", "duplicate"]);
  assert.equal((await c.json("GET", "/api/households/1/inventory")).body[0].quantity, 2);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM lots").get() as { n: number }).n, 1);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM shopping_items").get() as { n: number }).n, 1);
});

test("a retry after a partial first attempt applies only what is missing", async () => {
  const { c, L, sync } = await ready();
  await sync([{ type: "lot.add", client_id: "p1", location_id: L.Pantry, name: "Beans", quantity: 3 }]);
  const r = await sync([
    { type: "lot.add", client_id: "p1", location_id: L.Pantry, name: "Beans", quantity: 3 },
    { type: "lot.consume", client_id: "p2", lot_client_id: "p1", amount: 1 },
  ]);
  assert.deepEqual(statuses(r), ["duplicate", "applied"]);
  assert.equal((await c.json("GET", "/api/households/1/inventory")).body[0].quantity, 2);
});

test("consuming a lot that is gone is reported as gone, not invalid", async () => {
  const { sync } = await ready();
  const r = await sync([{ type: "lot.consume", client_id: "g1", lot_client_id: "never-existed", amount: 1 }]);
  assert.deepEqual(statuses(r), ["gone"]);
});

test("over-consume floors at zero and says so", async () => {
  const { c, L, sync } = await ready();
  const r = await sync([
    { type: "lot.add", client_id: "o1", location_id: L.Pantry, name: "Beans", quantity: 1 },
    { type: "lot.consume", client_id: "o2", lot_client_id: "o1", amount: 5 },
  ]);
  assert.equal(r.body.results[1].removed, true);
  assert.equal(r.body.results[1].floored, true);
  assert.equal((await c.json("GET", "/api/households/1/inventory")).body.length, 0);
});

test("a bad operation is invalid and does not block the others", async () => {
  const { c, L, sync } = await ready();
  const r = await sync([
    { type: "lot.add", client_id: "i1", location_id: 9999, name: "Beans", quantity: 1 },
    { type: "lot.add", client_id: "i2", location_id: L.Pantry, name: "Rice", quantity: 1, expires_on: "someday" },
    { type: "teleport", client_id: "i3" },
    { type: "lot.add", location_id: L.Pantry, name: "NoClientId", quantity: 1 },
    "garbage",
    { type: "lot.add", client_id: "i4", location_id: L.Pantry, name: "Good", quantity: 1 },
  ]);
  assert.deepEqual(statuses(r), ["invalid", "invalid", "invalid", "invalid", "invalid", "applied"]);
  assert.match(r.body.results[0].error, /location/i);
  assert.equal((await c.json("GET", "/api/households/1/inventory")).body.length, 1);
});

test("moving to a deleted location is invalid so the user can pick another", async () => {
  const { t, L, sync } = await ready();
  await sync([{ type: "lot.add", client_id: "m1", location_id: L.Pantry, name: "Beans", quantity: 1 }]);
  t.db.prepare("INSERT INTO locations(household_id,name,kind) VALUES (1,'Garage','other')").run();
  const garage = (t.db.prepare("SELECT id FROM locations WHERE name='Garage'").get() as { id: number }).id;
  t.db.prepare("DELETE FROM locations WHERE id = ?").run(garage);
  const r = await sync([{ type: "lot.move", client_id: "m2", lot_client_id: "m1", location_id: garage }]);
  assert.deepEqual(statuses(r), ["invalid"]);
});

test("an offline scan with no lookup is saved unresolved, then named by the background retry", async () => {
  let online = false;
  const { t, c, L, sync } = await ready({
    fetch: (async () => { if (!online) throw new Error("offline"); return json({ status: 1, product: { product_name: "Tomato Soup", brands: "Campbell's" } }); }) as typeof fetch,
  });
  const r = await sync([{ type: "lot.add", client_id: "s1", location_id: L.Pantry, barcode: "036000291452", quantity: 1, expires_on: "2027-02-02" }]);
  assert.deepEqual(statuses(r), ["applied"]);
  let inv = (await c.json("GET", "/api/households/1/inventory")).body;
  assert.equal(inv[0].resolved, 0);
  assert.equal(await resolvePendingProducts((t.app as unknown as { ctx: never }).ctx), 0);
  online = true;
  assert.equal(await resolvePendingProducts((t.app as unknown as { ctx: never }).ctx), 1);
  inv = (await c.json("GET", "/api/households/1/inventory")).body;
  assert.deepEqual([inv[0].name, inv[0].brand, inv[0].resolved, inv[0].expires_on], ["Tomato Soup", "Campbell's", 1, "2027-02-02"]);
});

test("shopping toggle and delete work by client id", async () => {
  const { c, sync } = await ready();
  const r = await sync([
    { type: "shopping.add", client_id: "h1", name: "Eggs" },
    { type: "shopping.toggle", client_id: "h2", item_client_id: "h1" },
    { type: "shopping.add", client_id: "h3", name: "Milk" },
    { type: "shopping.delete", client_id: "h4", item_client_id: "h3" },
    { type: "shopping.delete", client_id: "h5", item_client_id: "h3" },
  ]);
  assert.deepEqual(statuses(r), ["applied", "applied", "applied", "applied", "gone"]);
  const list = (await c.json("GET", "/api/households/1/shopping")).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].checked, 1);
});

test("limits and access control", async () => {
  const { t, c, L } = await ready();
  const many = Array.from({ length: 201 }, (_, i) => ({ type: "shopping.add", client_id: `x${i}`, name: "n" }));
  assert.equal((await c.json("POST", "/api/households/1/sync", { ops: many })).status, 400);
  assert.equal((await c.json("POST", "/api/households/1/sync", { ops: "no" })).status, 400);
  assert.equal((await t.client().json("POST", "/api/households/1/sync", { ops: [] })).status, 401);

  await c.json("POST", "/api/households", { name: "Cabin" });
  await c.json("POST", "/api/households/2/members", { username: "bob", password: "bob-pass-123" });
  const bob = await loginAs(t, "bob", "bob-pass-123");
  const denied = await bob.json("POST", "/api/households/1/sync", { ops: [{ type: "lot.add", client_id: "z", location_id: L.Pantry, name: "X", quantity: 1 }] });
  assert.equal(denied.status, 404);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM lots").get() as { n: number }).n, 0);
});

test("the same client_id in two households does not collide", async () => {
  const { t, c, L } = await ready();
  await c.json("POST", "/api/households", { name: "Cabin" });
  const cabinLoc = (t.db.prepare("SELECT id FROM locations WHERE household_id = 2 LIMIT 1").get() as { id: number }).id;
  const op = (loc: number) => [{ type: "lot.add", client_id: "same", location_id: loc, name: "Beans", quantity: 1 }];
  assert.deepEqual(statuses(await c.json("POST", "/api/households/1/sync", { ops: op(L.Pantry!) })), ["applied"]);
  assert.deepEqual(statuses(await c.json("POST", "/api/households/2/sync", { ops: op(cabinLoc) })), ["applied"]);
});
