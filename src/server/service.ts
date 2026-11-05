import type { Ctx } from "./context.ts";
import { HttpError } from "./context.ts";
import { resolveProduct, type ProductInput } from "./barcode.ts";
import { daysBetween, localParts } from "../shared/dates.ts";

const EPS = 1e-9;

export type OpStatus = "applied" | "duplicate" | "gone";
export interface OpResult {
  status: OpStatus;
  lot_id?: number;
  item_id?: number;
  removed?: boolean;
  floored?: boolean;
}

export function tx<T>(ctx: Ctx, fn: () => T): T {
  ctx.db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    ctx.db.exec("COMMIT");
    return r;
  } catch (e) {
    ctx.db.exec("ROLLBACK");
    throw e;
  }
}

function seen(ctx: Ctx, hid: number, clientId: string | undefined): OpResult | null {
  if (!clientId) return null;
  const row = ctx.db.prepare("SELECT result FROM applied_ops WHERE household_id = ? AND client_id = ?").get(hid, clientId) as { result: string } | undefined;
  return row ? { ...(JSON.parse(row.result) as OpResult), status: "duplicate" } : null;
}

function record(ctx: Ctx, hid: number, clientId: string | undefined, op: string, result: OpResult): void {
  if (clientId) ctx.db.prepare("INSERT INTO applied_ops(household_id,client_id,op,result) VALUES (?,?,?,?)").run(hid, clientId, op, JSON.stringify(result));
}

export interface LotTarget {
  lot_id?: number;
  lot_client_id?: string;
}

function findLot(ctx: Ctx, hid: number, t: LotTarget): { id: number; quantity: number } | undefined {
  if (t.lot_id !== undefined) return ctx.db.prepare("SELECT id, quantity FROM lots WHERE id = ? AND household_id = ?").get(t.lot_id, hid) as { id: number; quantity: number } | undefined;
  if (t.lot_client_id) return ctx.db.prepare("SELECT id, quantity FROM lots WHERE client_id = ? AND household_id = ?").get(t.lot_client_id, hid) as { id: number; quantity: number } | undefined;
  return undefined;
}

export interface AddLotInput extends ProductInput {
  client_id?: string;
  category?: string;
  location_id: number;
  quantity: number;
  unit: string;
  expires_on: string | null;
  purchased_on: string | null;
  notes: string | null;
}

export async function addLot(ctx: Ctx, hid: number, userId: number, input: AddLotInput): Promise<OpResult> {
  const dup = seen(ctx, hid, input.client_id);
  if (dup) return dup;
  const loc = ctx.db.prepare("SELECT id FROM locations WHERE id = ? AND household_id = ?").get(input.location_id, hid);
  if (!loc) throw new HttpError(400, "Unknown location");
  const productId = await resolveProduct(ctx, input);
  // The category belongs to the product, so the last choice is what the next add pre-selects.
  if (input.category) ctx.db.prepare("UPDATE products SET category = ? WHERE id = ? AND category <> ?").run(input.category, productId, input.category);
  return tx(ctx, () => {
    const again = seen(ctx, hid, input.client_id);
    if (again) return again;
    const lot = Number(
      ctx.db
        .prepare("INSERT INTO lots(client_id,household_id,location_id,product_id,quantity,unit,expires_on,purchased_on,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(input.client_id ?? null, hid, input.location_id, productId, input.quantity, input.unit, input.expires_on, input.purchased_on, input.notes, userId).lastInsertRowid,
    );
    const result: OpResult = { status: "applied", lot_id: lot };
    record(ctx, hid, input.client_id, "lot.add", result);
    return result;
  });
}

// Applies a decrement. Over-consuming floors at zero (the lot is removed) and a vanished lot is reported, never an error.
export function consumeLot(ctx: Ctx, hid: number, target: LotTarget, amount: number, clientId?: string): OpResult {
  return tx(ctx, () => {
    const dup = seen(ctx, hid, clientId);
    if (dup) return dup;
    const lot = findLot(ctx, hid, target);
    let result: OpResult;
    if (!lot) result = { status: "gone" };
    else if (amount >= lot.quantity - EPS) {
      ctx.db.prepare("DELETE FROM lots WHERE id = ?").run(lot.id);
      result = { status: "applied", lot_id: lot.id, removed: true, floored: amount > lot.quantity + EPS };
    } else {
      ctx.db.prepare("UPDATE lots SET quantity = ? WHERE id = ?").run(lot.quantity - amount, lot.id);
      result = { status: "applied", lot_id: lot.id, removed: false };
    }
    record(ctx, hid, clientId, "lot.consume", result);
    return result;
  });
}

export function moveLot(ctx: Ctx, hid: number, target: LotTarget, locationId: number, clientId?: string): OpResult {
  return tx(ctx, () => {
    const dup = seen(ctx, hid, clientId);
    if (dup) return dup;
    const loc = ctx.db.prepare("SELECT id FROM locations WHERE id = ? AND household_id = ?").get(locationId, hid);
    if (!loc) throw new HttpError(400, "Unknown location");
    const lot = findLot(ctx, hid, target);
    let result: OpResult;
    if (!lot) result = { status: "gone" };
    else {
      ctx.db.prepare("UPDATE lots SET location_id = ? WHERE id = ?").run(locationId, lot.id);
      result = { status: "applied", lot_id: lot.id };
    }
    record(ctx, hid, clientId, "lot.move", result);
    return result;
  });
}

export function addShopping(ctx: Ctx, hid: number, input: { client_id?: string; name: string; quantity: number; unit: string }): OpResult {
  return tx(ctx, () => {
    const dup = seen(ctx, hid, input.client_id);
    if (dup) return dup;
    const item = Number(
      ctx.db.prepare("INSERT INTO shopping_items(client_id,household_id,name,quantity,unit) VALUES (?,?,?,?,?)").run(input.client_id ?? null, hid, input.name, input.quantity, input.unit).lastInsertRowid,
    );
    const result: OpResult = { status: "applied", item_id: item };
    record(ctx, hid, input.client_id, "shopping.add", result);
    return result;
  });
}

export interface ItemTarget {
  item_id?: number;
  item_client_id?: string;
}

function findItem(ctx: Ctx, hid: number, t: ItemTarget): { id: number; checked: number } | undefined {
  if (t.item_id !== undefined) return ctx.db.prepare("SELECT id, checked FROM shopping_items WHERE id = ? AND household_id = ?").get(t.item_id, hid) as { id: number; checked: number } | undefined;
  if (t.item_client_id) return ctx.db.prepare("SELECT id, checked FROM shopping_items WHERE client_id = ? AND household_id = ?").get(t.item_client_id, hid) as { id: number; checked: number } | undefined;
  return undefined;
}

export function toggleShopping(ctx: Ctx, hid: number, target: ItemTarget, clientId?: string): OpResult {
  return tx(ctx, () => {
    const dup = seen(ctx, hid, clientId);
    if (dup) return dup;
    const item = findItem(ctx, hid, target);
    let result: OpResult;
    if (!item) result = { status: "gone" };
    else {
      ctx.db.prepare("UPDATE shopping_items SET checked = ? WHERE id = ?").run(item.checked ? 0 : 1, item.id);
      result = { status: "applied", item_id: item.id };
    }
    record(ctx, hid, clientId, "shopping.toggle", result);
    return result;
  });
}

export function deleteShopping(ctx: Ctx, hid: number, target: ItemTarget, clientId?: string): OpResult {
  return tx(ctx, () => {
    const dup = seen(ctx, hid, clientId);
    if (dup) return dup;
    const item = findItem(ctx, hid, target);
    let result: OpResult;
    if (!item) result = { status: "gone" };
    else {
      ctx.db.prepare("DELETE FROM shopping_items WHERE id = ?").run(item.id);
      result = { status: "applied", item_id: item.id };
    }
    record(ctx, hid, clientId, "shopping.delete", result);
    return result;
  });
}

export function householdToday(ctx: Ctx, hid: number): { today: string; warningDays: number } {
  const h = ctx.db.prepare("SELECT timezone, expiry_warning_days FROM households WHERE id = ?").get(hid) as { timezone: string; expiry_warning_days: number };
  return { today: localParts(ctx.now(), h.timezone).date, warningDays: h.expiry_warning_days };
}

export function listLots(ctx: Ctx, hid: number) {
  const { today } = householdToday(ctx, hid);
  const rows = ctx.db
    .prepare(
      `SELECT l.id, l.client_id, l.location_id, loc.name AS location_name, loc.kind AS location_kind,
              l.product_id, p.name, p.brand, p.image_url, p.barcode, p.resolved, p.category,
              l.quantity, l.unit, l.expires_on, l.purchased_on, l.notes, l.created_at
       FROM lots l JOIN products p ON p.id = l.product_id JOIN locations loc ON loc.id = l.location_id
       WHERE l.household_id = ?
       ORDER BY l.expires_on IS NULL, l.expires_on, p.name`,
    )
    .all(hid) as Array<Record<string, unknown> & { expires_on: string | null; quantity: number }>;
  return rows.map((r) => ({ ...r, days_until_expiry: r.expires_on ? daysBetween(today, r.expires_on) : null }));
}

export function dashboard(ctx: Ctx, hid: number) {
  const { warningDays } = householdToday(ctx, hid);
  const lots = listLots(ctx, hid);
  const dated = lots.filter((l) => l.days_until_expiry !== null) as Array<(typeof lots)[number] & { days_until_expiry: number }>;
  const open = ctx.db.prepare("SELECT COUNT(*) AS n FROM shopping_items WHERE household_id = ? AND checked = 0").get(hid) as { n: number };
  return {
    warning_days: warningDays,
    lots: lots.length,
    total_quantity: lots.reduce((s, l) => s + l.quantity, 0),
    expired: dated.filter((l) => l.days_until_expiry < 0).length,
    expiring_soon: dated.filter((l) => l.days_until_expiry >= 0 && l.days_until_expiry <= warningDays).length,
    expiring_7_days: dated.filter((l) => l.days_until_expiry >= 0 && l.days_until_expiry <= 7).length,
    shopping_open: open.n,
    expiring: dated.filter((l) => l.days_until_expiry <= 14).slice(0, 30),
  };
}
