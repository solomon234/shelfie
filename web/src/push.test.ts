import assert from "node:assert/strict";
import { test } from "node:test";
import { urlBase64ToUint8Array } from "./push.ts";

test("VAPID public keys decode from URL-safe base64, with or without padding", () => {
  // 65-byte uncompressed P-256 point, as web-push generates (87 chars, no padding)
  const key = Buffer.alloc(65, 7);
  key[0] = 4;
  const b64 = key.toString("base64url");
  const out = urlBase64ToUint8Array(b64);
  assert.equal(out.length, 65);
  assert.equal(out[0], 4);
  assert.deepEqual(Array.from(urlBase64ToUint8Array("-_8")), [251, 255]);
  assert.deepEqual(Array.from(urlBase64ToUint8Array("-_8=")), [251, 255]);
});
