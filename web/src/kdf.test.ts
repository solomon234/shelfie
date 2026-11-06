import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { test } from "node:test";
import { stretchPassword } from "./kdf.ts";

test("stretchPassword is PBKDF2-SHA256 over the lower-cased username, base64url encoded", async () => {
  const got = await stretchPassword("  Alex ", "correct horse", 1000);
  const want = pbkdf2Sync("correct horse", "shelfie:v1:alex", 1000, 32, "sha256").toString("base64url");
  assert.equal(got, want);
  assert.equal(got.length, 43);
});

test("a different user or password gives a different proof", async () => {
  const a = await stretchPassword("alex", "correct horse", 1000);
  assert.notEqual(a, await stretchPassword("sam", "correct horse", 1000));
  assert.notEqual(a, await stretchPassword("alex", "correct horses", 1000));
});
