import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const entry = join(import.meta.dirname, "index.ts");

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "shelfie-start-"));
  const res = spawnSync(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? "", SHELFIE_DB: join(dir, "d", "s.db"), ...env },
    encoding: "utf8",
    timeout: 8000,
  });
  return { ...res, dir };
}

test("rejects a non-numeric PORT with a clear message", () => {
  const r = run({ PORT: "abc", SHELFIE_API_ONLY: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PORT must be an integer/);
});

test("fails clearly when the built frontend is missing", () => {
  const r = run({ PORT: "8799", SHELFIE_WEB_DIR: "/nonexistent/web" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /built frontend not found/);
});

test("fails clearly when the data directory is not writable", { skip: process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "shelfie-ro-"));
  const ro = join(dir, "ro");
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  const r = spawnSync(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? "", SHELFIE_DB: join(ro, "s.db"), SHELFIE_API_ONLY: "1" },
    encoding: "utf8",
    timeout: 8000,
  });
  chmodSync(ro, 0o700);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not writable/);
});
