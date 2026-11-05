import type { Hono } from "hono";
import type { Ctx, Env } from "./context.ts";
import { HttpError } from "./context.ts";
import { requireAuth, roleIn } from "./auth.ts";
import { addLot, addShopping, consumeLot, deleteShopping, moveLot, toggleShopping, type OpResult } from "./service.ts";
import { id, isoDate, num, optNum, optStr, readBody, str } from "./validate.ts";

export const MAX_SYNC_OPS = 200;

type Raw = Record<string, unknown>;
const target = (o: Raw) => ({
  lot_id: optNum(o, "lot_id", { int: true, min: 1 }),
  lot_client_id: optStr(o, "lot_client_id", 80) ?? undefined,
});
const itemTarget = (o: Raw) => ({
  item_id: optNum(o, "item_id", { int: true, min: 1 }),
  item_client_id: optStr(o, "item_client_id", 80) ?? undefined,
});

async function applyOp(ctx: Ctx, hid: number, userId: number, op: Raw): Promise<OpResult> {
  const clientId = str(op, "client_id", 1, 80);
  switch (op.type) {
    case "lot.add":
      return addLot(ctx, hid, userId, {
        client_id: clientId,
        location_id: num(op, "location_id", { int: true, min: 1 }),
        barcode: optStr(op, "barcode", 32),
        name: optStr(op, "name", 180),
        brand: optStr(op, "brand", 120),
        image_url: optStr(op, "image_url", 500),
        quantity: num(op, "quantity", { min: 0.001, max: 100000 }),
        unit: optStr(op, "unit", 30) ?? "item",
        expires_on: isoDate(op.expires_on, "expires_on"),
        purchased_on: isoDate(op.purchased_on, "purchased_on"),
        notes: optStr(op, "notes", 500),
      });
    case "lot.consume":
      return consumeLot(ctx, hid, target(op), optNum(op, "amount", { min: 0.001, max: 100000 }) ?? 1, clientId);
    case "lot.move":
      return moveLot(ctx, hid, target(op), num(op, "location_id", { int: true, min: 1 }), clientId);
    case "shopping.add":
      return addShopping(ctx, hid, { client_id: clientId, name: str(op, "name", 1, 180), quantity: optNum(op, "quantity", { min: 0.001, max: 100000 }) ?? 1, unit: optStr(op, "unit", 30) ?? "item" });
    case "shopping.toggle":
      return toggleShopping(ctx, hid, itemTarget(op), clientId);
    case "shopping.delete":
      return deleteShopping(ctx, hid, itemTarget(op), clientId);
    default:
      throw new HttpError(400, `Unknown operation type "${String(op.type)}"`);
  }
}

export function registerSyncRoutes(app: Hono<Env>, ctx: Ctx): void {
  const auth = requireAuth(ctx);

  // Replays a client's offline outbox in order. Each operation is independent: a bad one is
  // reported as `invalid` and does not block the rest. Replaying the same batch is safe.
  app.post("/api/households/:id/sync", auth, async (c) => {
    const hid = id(c.req.param("id"), "household");
    const user = c.get("user");
    roleIn(ctx, user.id, hid);
    const body = await readBody(c);
    if (!Array.isArray(body.ops)) throw new HttpError(400, "ops must be an array");
    if (body.ops.length > MAX_SYNC_OPS) throw new HttpError(400, `At most ${MAX_SYNC_OPS} operations per request`);

    const results: Array<Record<string, unknown>> = [];
    for (const raw of body.ops as unknown[]) {
      const op = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Raw) : {};
      const clientId = typeof op.client_id === "string" ? op.client_id : null;
      try {
        results.push({ client_id: clientId, ...(await applyOp(ctx, hid, user.id, op)) });
      } catch (e) {
        if (e instanceof HttpError) results.push({ client_id: clientId, status: "invalid", error: e.message });
        else {
          console.error(e);
          results.push({ client_id: clientId, status: "retry", error: "Server error" });
        }
      }
    }
    return c.json({ results });
  });
}
