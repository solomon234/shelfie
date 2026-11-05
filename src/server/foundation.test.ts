import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "./app.ts";
import { migrate, openDb } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";

function seedHousehold(db: DatabaseSync, name = "Home") {
  const h = Number(db.prepare("INSERT INTO households(name) VALUES (?)").run(name).lastInsertRowid);
  const l = Number(db.prepare("INSERT INTO locations(household_id,name) VALUES (?,?)").run(h, "Pantry").lastInsertRowid);
  const p = Number(db.prepare("INSERT INTO products(name,name_key) VALUES (?,?)").run(`Beans ${name}`, `beans ${name}`).lastInsertRowid);
  return { h, l, p };
}
const insertLot = (db: DatabaseSync, h: number, l: number, p: number, q = 1, exp: string | null = null, cid: string | null = null) =>
  db
    .prepare("INSERT INTO lots(household_id,location_id,product_id,quantity,expires_on,client_id) VALUES (?,?,?,?,?,?)")
    .run(h, l, p, q, exp, cid);

test("migrations apply once and record user_version", () => {
  const db = openDb(":memory:");
  const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(v.user_version, MIGRATIONS.length);
  migrate(db); // second run is a no-op
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
});

test("migrating an existing file keeps its data", () => {
  const path = join(mkdtempSync(join(tmpdir(), "shelfie-")), "t.db");
  const a = openDb(path);
  a.prepare("INSERT INTO households(name) VALUES ('Keep')").run();
  a.close();
  const b = openDb(path, [...MIGRATIONS, "ALTER TABLE households ADD COLUMN note TEXT;"]);
  assert.equal((b.prepare("SELECT name FROM households").get() as { name: string }).name, "Keep");
  assert.equal((b.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
});

test("a failed migration rolls back and leaves the version unchanged", () => {
  const db = new DatabaseSync(":memory:");
  assert.throws(() => migrate(db, ["CREATE TABLE a(x);", "CREATE TABLE b(x); CREATE TABLE a(x);"]));
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='b'").get(), undefined);
});

test("refuses a database newer than the code", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version = 99");
  assert.throws(() => migrate(db), /newer than this build/);
});

test("foreign keys are enforced", () => {
  const db = openDb(":memory:");
  const { h, l } = seedHousehold(db);
  assert.throws(() => insertLot(db, h, l, 9999));
});

test("a lot cannot reference another household's location", () => {
  const db = openDb(":memory:");
  const a = seedHousehold(db, "A");
  const b = seedHousehold(db, "B");
  assert.throws(() => insertLot(db, a.h, b.l, a.p), /FOREIGN KEY/);
  insertLot(db, a.h, a.l, a.p);
});

test("quantity must be positive and dates must be ISO", () => {
  const db = openDb(":memory:");
  const { h, l, p } = seedHousehold(db);
  assert.throws(() => insertLot(db, h, l, p, 0));
  assert.throws(() => insertLot(db, h, l, p, 1, "next tuesday"));
  assert.throws(() => insertLot(db, h, l, p, 1, "2026-02-30"));
  insertLot(db, h, l, p, 1, "2026-12-31");
});

test("client_id is unique per household, not globally", () => {
  const db = openDb(":memory:");
  const a = seedHousehold(db, "A");
  const b = seedHousehold(db, "B");
  insertLot(db, a.h, a.l, a.p, 1, null, "same");
  assert.throws(() => insertLot(db, a.h, a.l, a.p, 1, null, "same"));
  insertLot(db, b.h, b.l, b.p, 1, null, "same");
});

test("household names may repeat; product names are unique only without a barcode", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households(name) VALUES ('Home')").run();
  db.prepare("INSERT INTO households(name) VALUES ('Home')").run();
  db.prepare("INSERT INTO products(name,name_key) VALUES ('Apples','apples')").run();
  assert.throws(() => db.prepare("INSERT INTO products(name,name_key) VALUES ('APPLES','apples')").run());
  db.prepare("INSERT INTO products(barcode,name,name_key) VALUES ('0012345678905','Apples','apples')").run();
});

test("health, unknown API paths 404 as JSON for every method", async () => {
  const app = createApp(openDb(":memory:"));
  const health = await app.request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { ok: boolean }).ok, true);
  for (const method of ["GET", "POST", "DELETE"]) {
    const res = await app.request("/api/nope", { method });
    assert.equal(res.status, 404, method);
    assert.match(res.headers.get("content-type") ?? "", /json/);
  }
});

test("oversized API bodies are rejected", async () => {
  const app = createApp(openDb(":memory:"));
  const res = await app.request("/api/anything", { method: "POST", body: "x".repeat(2 * 1024 * 1024) });
  assert.equal(res.status, 413);
});

test("static serving: app shell, SPA fallback, real 404s, no traversal, API not shadowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "shelfie-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<html>shell</html>");
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(root, "manifest.webmanifest"), "{}");
  const app = createApp(openDb(":memory:"), { staticRoot: root });

  const index = await app.request("/");
  assert.equal(index.status, 200);
  assert.equal(await index.text(), "<html>shell</html>");
  assert.equal(index.headers.get("cache-control"), "no-cache");

  const route = await app.request("/inventory/42");
  assert.equal(await route.text(), "<html>shell</html>");

  const asset = await app.request("/assets/app.js");
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

  assert.equal((await app.request("/assets/missing.js")).status, 404);
  const traversal = await app.request("/%2e%2e/%2e%2e/etc/passwd");
  assert.ok(!(await traversal.text()).includes("root:"));
  const encoded = await app.request("/..%2f..%2fetc%2fpasswd");
  assert.ok(!(await encoded.text()).includes("root:"));
  assert.equal((await app.request("/api/nope")).status, 404);
  assert.match((await app.request("/api/nope")).headers.get("content-type") ?? "", /json/);
});
