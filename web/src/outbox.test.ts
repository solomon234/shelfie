import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { test } from "node:test";
import { overlayLots, overlayShopping, type Lot } from "./overlay.ts";
import { createStore, type Notice, type QueuedOp } from "./store.ts";
import { replay } from "./sync.ts";

const fresh = () => createStore(new IDBFactory(), "t" + Math.random());
const add = (store: ReturnType<typeof fresh>, client_id: string, extra: Record<string, unknown> = {}, household_id = 1) =>
  store.enqueue({ household_id, client_id, type: "lot.add", payload: { location_id: 1, name: "Beans", quantity: 2, unit: "can", ...extra } });

function server(handler: (hid: number, ops: { client_id: string; type: string }[]) => unknown[] | Response) {
  const calls: { hid: number; ops: { client_id: string; type: string }[] }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const hid = Number(/households\/(\d+)\/sync/.exec(url)![1]);
    const ops = JSON.parse(init.body as string).ops;
    calls.push({ hid, ops });
    const r = handler(hid, ops);
    return r instanceof Response ? r : new Response(JSON.stringify({ results: r }), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}
const allApplied = (_: number, ops: { client_id: string }[]) => ops.map((o) => ({ client_id: o.client_id, status: "applied" }));

test("the outbox keeps operations in order across reopen", async () => {
  const factory = new IDBFactory();
  const a = createStore(factory, "x");
  await add(a, "1");
  await add(a, "2");
  await a.kvSet("k", { v: 1 });
  const b = createStore(factory, "x");
  assert.deepEqual((await b.listOps()).map((o) => o.client_id), ["1", "2"]);
  assert.deepEqual(await b.kvGet("k"), { v: 1 });
});

test("replay sends ops in order and clears the applied ones", async () => {
  const store = fresh();
  await add(store, "a");
  await store.enqueue({ household_id: 1, client_id: "b", type: "lot.consume", payload: { lot_client_id: "a", amount: 1 } });
  const s = server(allApplied);
  const r = await replay({ store, fetch: s.f });
  assert.deepEqual(r, { applied: 2, remaining: 0, offline: false, unauthorized: false });
  assert.deepEqual(s.calls[0]!.ops.map((o) => [o.client_id, o.type]), [["a", "lot.add"], ["b", "lot.consume"]]);
  assert.equal((await store.listOps()).length, 0);
});

test("offline: nothing is lost and the next replay succeeds", async () => {
  const store = fresh();
  await add(store, "a");
  const down = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  assert.deepEqual(await replay({ store, fetch: down }), { applied: 0, remaining: 1, offline: true, unauthorized: false });
  assert.equal((await store.listOps()).length, 1);
  const s = server(allApplied);
  assert.equal((await replay({ store, fetch: s.f })).remaining, 0);
});

test("an interrupted replay is retried and duplicates are treated as done", async () => {
  const store = fresh();
  await add(store, "a");
  await add(store, "b");
  // The server applied everything but the response was lost.
  await assert.doesNotReject(replay({ store, fetch: (async () => { throw new TypeError("network"); }) as typeof fetch }));
  const s = server((_, ops) => ops.map((o) => ({ client_id: o.client_id, status: "duplicate" })));
  const r = await replay({ store, fetch: s.f });
  assert.equal(r.remaining, 0);
  assert.equal((await store.listOps()).length, 0);
});

test("invalid ops move to needs-attention and do not block the rest or get resent", async () => {
  const store = fresh();
  await add(store, "bad");
  await add(store, "good");
  const s = server((_, ops) => [{ client_id: ops[0]!.client_id, status: "invalid", error: "Unknown location" }, { client_id: ops[1]!.client_id, status: "applied" }]);
  const r = await replay({ store, fetch: s.f });
  assert.equal(r.remaining, 0);
  const left = await store.listOps();
  assert.deepEqual(left.map((o) => [o.client_id, o.status, o.error]), [["bad", "invalid", "Unknown location"]]);
  const s2 = server(allApplied);
  await replay({ store, fetch: s2.f });
  assert.equal(s2.calls.length, 0);
});

test("gone and floored consumes leave a notice", async () => {
  const store = fresh();
  await store.enqueue({ household_id: 1, client_id: "c1", type: "lot.consume", payload: { lot_id: 5, amount: 1, label: "Milk" } });
  await store.enqueue({ household_id: 1, client_id: "c2", type: "lot.consume", payload: { lot_id: 6, amount: 9, label: "Rice" } });
  const s = server((_, ops) => [{ client_id: ops[0]!.client_id, status: "gone" }, { client_id: ops[1]!.client_id, status: "applied", floored: true }]);
  await replay({ store, fetch: s.f, now: () => new Date("2026-11-05T10:00:00Z") });
  const notices = (await store.kvGet<Notice[]>("notices"))!;
  assert.equal(notices.length, 2);
  assert.match(notices[0]!.text, /Milk was already used up/);
  assert.match(notices[1]!.text, /Rice/);
});

test("401 stops and keeps the outbox; 5xx is treated as offline", async () => {
  const store = fresh();
  await add(store, "a");
  assert.deepEqual(await replay({ store, fetch: (async () => new Response("", { status: 401 })) as typeof fetch }), { applied: 0, remaining: 1, offline: false, unauthorized: true });
  assert.equal((await replay({ store, fetch: (async () => new Response("", { status: 503 })) as typeof fetch })).offline, true);
  assert.equal((await store.listOps()).length, 1);
});

test("a retry result keeps the op and counts the attempt", async () => {
  const store = fresh();
  await add(store, "a");
  const s = server((_, ops) => [{ client_id: ops[0]!.client_id, status: "retry" }]);
  const r = await replay({ store, fetch: s.f });
  assert.equal(r.remaining, 1);
  assert.equal((await store.listOps())[0]!.attempts, 1);
});

test("ops are grouped per household, in order, and batched at 200", async () => {
  const store = fresh();
  await add(store, "a", {}, 1);
  await add(store, "b", {}, 2);
  await add(store, "c", {}, 1);
  const s = server(allApplied);
  await replay({ store, fetch: s.f });
  assert.deepEqual(s.calls.map((c) => [c.hid, c.ops.map((o) => o.client_id)]), [[1, ["a"]], [2, ["b"]], [1, ["c"]]]);

  const big = fresh();
  for (let i = 0; i < 450; i++) await add(big, "n" + i);
  const s2 = server(allApplied);
  await replay({ store: big, fetch: s2.f });
  assert.deepEqual(s2.calls.map((c) => c.ops.length), [200, 200, 50]);
});

test("only one replay runs at a time", async () => {
  const store = fresh();
  await add(store, "a");
  let calls = 0;
  const slow = (async (_: string, init: RequestInit) => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ results: JSON.parse(init.body as string).ops.map((o: { client_id: string }) => ({ client_id: o.client_id, status: "applied" })) }));
  }) as typeof fetch;
  await Promise.all([replay({ store, fetch: slow }), replay({ store, fetch: slow }), replay({ store, fetch: slow })]);
  assert.equal(calls, 1);
});

const lot = (o: Partial<Lot>): Lot => ({ id: 1, location_id: 1, location_name: "Pantry", name: "Beans", brand: null, image_url: null, barcode: null, resolved: 1, quantity: 3, unit: "can", expires_on: null, purchased_on: null, notes: null, ...o });
const q = (type: QueuedOp["type"], client_id: string, payload: Record<string, unknown>): QueuedOp => ({ household_id: 1, client_id, type, payload, created_at: "", attempts: 0, status: "pending" });
const locs = [{ id: 1, name: "Pantry" }, { id: 2, name: "Freezer" }];

test("overlay shows queued adds, consumes and moves immediately", () => {
  const server = [lot({ id: 1 }), lot({ id: 2, name: "Milk", quantity: 1, expires_on: "2026-11-09" })];
  const out = overlayLots(server, [
    q("lot.add", "n1", { location_id: 2, name: "Peas", quantity: 2, unit: "bag", expires_on: "2026-12-01" }),
    q("lot.consume", "n2", { lot_id: 1, amount: 1 }),
    q("lot.consume", "n3", { lot_id: 2, amount: 1 }),
    q("lot.consume", "n4", { lot_client_id: "n1", amount: 1 }),
    q("lot.move", "n5", { lot_client_id: "n1", location_id: 1 }),
  ], 1, locs, new Map());
  assert.deepEqual(out.map((l) => [l.name, l.quantity, l.location_name]), [["Peas", 1, "Pantry"], ["Beans", 2, "Pantry"]]);
  assert.ok(out[0]!.pending);
});

test("overlay names an offline barcode scan from known products, else marks it unresolved", () => {
  const known = new Map([["0036000291452", "Kleenex"]]);
  const out = overlayLots([], [q("lot.add", "a", { location_id: 1, barcode: "0036000291452", quantity: 1 }), q("lot.add", "b", { location_id: 1, barcode: "0051000012616", quantity: 1 })], 1, locs, known);
  const by = Object.fromEntries(out.map((l) => [l.client_id!, l]));
  assert.deepEqual([by.a!.name, by.a!.resolved], ["Kleenex", 1]);
  assert.deepEqual([by.b!.name, by.b!.resolved], ["0051000012616", 0]);
});

test("overlay ignores invalid ops and ops already on the server", () => {
  const server = [lot({ id: 9, client_id: "dup" })];
  const bad: QueuedOp = { ...q("lot.add", "x", { location_id: 1, name: "Nope", quantity: 1 }), status: "invalid" };
  const out = overlayLots(server, [bad, q("lot.add", "dup", { location_id: 1, name: "Beans", quantity: 3 })], 1, locs, new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0]!.pending, undefined);
});

test("overlay applies shopping changes", () => {
  const out = overlayShopping([{ id: 1, name: "Eggs", quantity: 12, unit: "item", checked: 0 }, { id: 2, name: "Milk", quantity: 1, unit: "item", checked: 0 }], [
    q("shopping.add", "s1", { name: "Rice", quantity: 1 }),
    q("shopping.toggle", "s2", { item_id: 1 }),
    q("shopping.delete", "s3", { item_id: 2 }),
  ], 1);
  assert.deepEqual(out.map((i) => [i.name, i.checked]), [["Rice", 0], ["Eggs", 1]]);
});
