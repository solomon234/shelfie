import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { backupDatabase } from "./backup.ts";
import { openDb } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "shelfie-bk-"));

test("a backup taken while the database is open and busy restores cleanly", async () => {
  const dir = tmp();
  const live = openDb(join(dir, "live.db")); // WAL mode, connection stays open like the server's
  for (let i = 0; i < 200; i++) live.prepare("INSERT INTO households(name) VALUES (?)").run(`H${i}`);
  const { file } = await backupDatabase(join(dir, "live.db"), join(dir, "out"));
  live.prepare("INSERT INTO households(name) VALUES ('after')").run();

  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal((copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  assert.equal((copy.prepare("SELECT COUNT(*) n FROM households").get() as { n: number }).n, 200);
  assert.equal((copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
  copy.close();
  live.close();
});

test("only the newest N backups are kept", async () => {
  const dir = tmp();
  openDb(join(dir, "live.db")).close();
  for (let i = 0; i < 5; i++) await backupDatabase(join(dir, "live.db"), join(dir, "out"), 3, new Date(Date.UTC(2026, 10, 1 + i, 3, 0, 0)));
  assert.deepEqual(readdirSync(join(dir, "out")).sort(), ["shelfie-20261103-030000.db", "shelfie-20261104-030000.db", "shelfie-20261105-030000.db"]);
});

test("a missing source database is an error, not an empty backup", async () => {
  const dir = tmp();
  await assert.rejects(backupDatabase(join(dir, "nope.db"), join(dir, "out")));
  assert.equal(readdirSync(join(dir, "out")).length, 0);
});
