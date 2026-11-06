import type { Hono } from "hono";
import type { Ctx, Env } from "./context.ts";
import { HttpError } from "./context.ts";
import { requireAuth, roleIn } from "./auth.ts";
import { lookupProduct, requireBarcode } from "./barcode.ts";
import { addLot, addShopping, consumeLot, dashboard, deleteShopping, listLots, moveLot, toggleShopping } from "./service.ts";
import { id, isoDate, num, optCategory, optNum, optStr, readBody, str } from "./validate.ts";

const clientId = (b: Record<string, unknown>) => optStr(b, "client_id", 80) ?? undefined;

export function registerInventoryRoutes(app: Hono<Env>, ctx: Ctx): void {
  const auth = requireAuth(ctx);
  const member = (c: { req: { param(k: string): string }; get(k: "user"): { id: number } }) => {
    const hid = id(c.req.param("id"), "household");
    roleIn(ctx, c.get("user").id, hid);
    return hid;
  };

  app.get("/api/products/:barcode", auth, async (c) => {
    const code = requireBarcode(c.req.param("barcode"));
    const local = ctx.db.prepare("SELECT name, brand, image_url, category FROM products WHERE barcode = ? AND resolved = 1").get(code) as
      | { name: string; brand: string | null; image_url: string | null; category: string }
      | undefined;
    if (local) return c.json({ found: true, barcode: code, ...local });
    return c.json({ barcode: code, ...(await lookupProduct(ctx, code)) });
  });

  app.get("/api/households/:id/inventory", auth, (c) => c.json(listLots(ctx, member(c))));
  app.get("/api/households/:id/dashboard", auth, (c) => c.json(dashboard(ctx, member(c))));

  app.post("/api/households/:id/lots", auth, async (c) => {
    const hid = member(c);
    const b = await readBody(c);
    const result = await addLot(ctx, hid, c.get("user").id, {
      client_id: clientId(b),
      location_id: num(b, "location_id", { int: true, min: 1 }),
      barcode: optStr(b, "barcode", 32),
      name: optStr(b, "name", 180),
      brand: optStr(b, "brand", 120),
      image_url: optStr(b, "image_url", 500),
      quantity: num(b, "quantity", { min: 0.001, max: 100000 }),
      unit: optStr(b, "unit", 30) ?? "item",
      expires_on: isoDate(b.expires_on, "expires_on"),
      purchased_on: isoDate(b.purchased_on, "purchased_on"),
      notes: optStr(b, "notes", 500),
      category: optCategory(b),
    });
    return c.json(result, result.status === "duplicate" ? 200 : 201);
  });

  app.post("/api/households/:id/lots/:lotId/consume", auth, async (c) => {
    const hid = member(c);
    const b = await readBody(c);
    return c.json(consumeLot(ctx, hid, { lot_id: id(c.req.param("lotId"), "lot") }, optNum(b, "amount", { min: 0.001, max: 100000 }) ?? 1, clientId(b)));
  });

  app.post("/api/households/:id/lots/:lotId/move", auth, async (c) => {
    const hid = member(c);
    const b = await readBody(c);
    return c.json(moveLot(ctx, hid, { lot_id: id(c.req.param("lotId"), "lot") }, num(b, "location_id", { int: true, min: 1 }), clientId(b)));
  });

  app.patch("/api/households/:id/lots/:lotId", auth, async (c) => {
    const hid = member(c);
    const lotId = id(c.req.param("lotId"), "lot");
    const b = await readBody(c);
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const q = optNum(b, "quantity", { min: 0.001, max: 100000 });
    if (q !== undefined) (sets.push("quantity = ?"), vals.push(q));
    if (b.unit !== undefined) (sets.push("unit = ?"), vals.push(str(b, "unit", 1, 30)));
    if ("expires_on" in b) (sets.push("expires_on = ?"), vals.push(isoDate(b.expires_on, "expires_on")));
    if ("notes" in b) (sets.push("notes = ?"), vals.push(optStr(b, "notes", 500)));
    const category = optCategory(b);
    if (!sets.length && !category) throw new HttpError(400, "Nothing to update");
    if (sets.length) {
      const run = ctx.db.prepare(`UPDATE lots SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals, lotId, hid);
      if (!run.changes) throw new HttpError(404, "Lot not found");
    } else if (!ctx.db.prepare("SELECT 1 FROM lots WHERE id = ? AND household_id = ?").get(lotId, hid)) {
      throw new HttpError(404, "Lot not found");
    }
    // The category is on the product, so it applies to every lot of that product.
    if (category) ctx.db.prepare("UPDATE products SET category = ? WHERE id = (SELECT product_id FROM lots WHERE id = ?)").run(category, lotId);
    // A changed expiry date starts a fresh alert cycle for the lot.
    if ("expires_on" in b) ctx.db.prepare("DELETE FROM alert_state WHERE lot_id = ?").run(lotId);
    return c.json({ ok: true });
  });

  app.delete("/api/households/:id/lots/:lotId", auth, (c) => {
    const hid = member(c);
    const run = ctx.db.prepare("DELETE FROM lots WHERE id = ? AND household_id = ?").run(id(c.req.param("lotId"), "lot"), hid);
    if (!run.changes) throw new HttpError(404, "Lot not found");
    return c.json({ ok: true });
  });

  app.get("/api/households/:id/shopping", auth, (c) => {
    const hid = member(c);
    return c.json(ctx.db.prepare("SELECT id, client_id, name, quantity, unit, checked FROM shopping_items WHERE household_id = ? ORDER BY checked, id").all(hid));
  });

  app.post("/api/households/:id/shopping", auth, async (c) => {
    const hid = member(c);
    const b = await readBody(c);
    const r = addShopping(ctx, hid, { client_id: clientId(b), name: str(b, "name", 1, 180), quantity: optNum(b, "quantity", { min: 0.001, max: 100000 }) ?? 1, unit: optStr(b, "unit", 30) ?? "item" });
    return c.json(r, r.status === "duplicate" ? 200 : 201);
  });

  app.post("/api/households/:id/shopping/:itemId/toggle", auth, async (c) => {
    const hid = member(c);
    const b = await readBody(c).catch(() => ({}) as Record<string, unknown>);
    return c.json(toggleShopping(ctx, hid, { item_id: id(c.req.param("itemId"), "item") }, clientId(b)));
  });

  app.delete("/api/households/:id/shopping/:itemId", auth, (c) => {
    const hid = member(c);
    const r = deleteShopping(ctx, hid, { item_id: id(c.req.param("itemId"), "item") });
    if (r.status === "gone") throw new HttpError(404, "Item not found");
    return c.json(r);
  });

  // "Add to shopping" from an inventory lot: increments an open item of the same name.
  app.post("/api/households/:id/lots/:lotId/shopping", auth, (c) => {
    const hid = member(c);
    const lot = ctx.db
      .prepare("SELECT p.name, l.unit FROM lots l JOIN products p ON p.id = l.product_id WHERE l.id = ? AND l.household_id = ?")
      .get(id(c.req.param("lotId"), "lot"), hid) as { name: string; unit: string } | undefined;
    if (!lot) throw new HttpError(404, "Lot not found");
    return c.json(
      ctx.db.transaction(() => {
        const open = ctx.db.prepare("SELECT id FROM shopping_items WHERE household_id = ? AND checked = 0 AND lower(name) = lower(?)").get(hid, lot.name) as { id: number } | undefined;
        if (open) {
          ctx.db.prepare("UPDATE shopping_items SET quantity = quantity + 1 WHERE id = ?").run(open.id);
          return { status: "applied", item_id: open.id, added: false };
        }
        const item = Number(ctx.db.prepare("INSERT INTO shopping_items(household_id,name,quantity,unit) VALUES (?,?,1,?)").run(hid, lot.name, lot.unit).lastInsertRowid);
        return { status: "applied", item_id: item, added: true };
      }),
    );
  });
}
