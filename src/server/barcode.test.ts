import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupProduct, normalizeBarcode } from "./barcode.ts";
import type { Ctx } from "./context.ts";

const ctxWith = (fetchImpl: typeof fetch): Ctx => ({ db: null as never, now: () => new Date(), fetch: fetchImpl, userAgent: "Shelfie-test/1.0", defaultTargets: {}, sendPush: async () => "ok" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("UPC-A and the same EAN-13 normalize to one code", () => {
  assert.equal(normalizeBarcode("036000291452"), "0036000291452");
  assert.equal(normalizeBarcode("0036000291452"), "0036000291452");
  assert.equal(normalizeBarcode("0 36000-291452"), "0036000291452");
});

test("EAN-8 is kept as is and bad check digits or lengths are rejected", () => {
  assert.equal(normalizeBarcode("96385074"), "96385074");
  assert.equal(normalizeBarcode("036000291453"), null);
  assert.equal(normalizeBarcode("12345"), null);
  assert.equal(normalizeBarcode("abc"), null);
  assert.equal(normalizeBarcode("123456789012345"), null);
});

test("lookup maps the Open Food Facts response and sends a User-Agent", async () => {
  let seenUa = "";
  let seenUrl = "";
  const ctx = ctxWith((async (url: string, init: RequestInit) => {
    seenUrl = String(url);
    seenUa = (init.headers as Record<string, string>)["User-Agent"]!;
    return json({ status: 1, product: { product_name: " Tomato Soup ", brands: "Campbell's, Other", image_front_small_url: "https://img/x.jpg" } });
  }) as typeof fetch);
  const r = await lookupProduct(ctx, "0051000012616");
  assert.deepEqual(r, { found: true, name: "Tomato Soup", brand: "Campbell's", image_url: "https://img/x.jpg" });
  assert.equal(seenUa, "Shelfie-test/1.0");
  assert.match(seenUrl, /0051000012616\.json/);
});

test("lookup never throws: not found, HTTP errors, network errors and non-https images", async () => {
  assert.deepEqual(await lookupProduct(ctxWith((async () => json({ status: 0 })) as typeof fetch), "0051000012616"), { found: false });
  assert.deepEqual(await lookupProduct(ctxWith((async () => json({}, 500)) as typeof fetch), "0051000012616"), { found: false });
  assert.deepEqual(await lookupProduct(ctxWith((async () => { throw new Error("offline"); }) as typeof fetch), "0051000012616"), { found: false });
  assert.deepEqual(await lookupProduct(ctxWith((async () => new Response("<html>", { status: 200 })) as typeof fetch), "0051000012616"), { found: false });
  const r = await lookupProduct(ctxWith((async () => json({ status: 1, product: { product_name: "A", image_front_small_url: "http://insecure/x.jpg" } })) as typeof fetch), "0051000012616");
  assert.equal(r.image_url, undefined);
});
