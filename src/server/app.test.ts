import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

test("health reports first run on an empty database", async () => {
  const app = createApp(openDb(":memory:"));
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, first_run: true });
});
