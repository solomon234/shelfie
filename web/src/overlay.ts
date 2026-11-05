import type { QueuedOp } from "./store.ts";

export interface Lot {
  id: number | string;
  client_id?: string | null;
  location_id: number;
  location_name: string;
  name: string;
  brand: string | null;
  image_url: string | null;
  barcode: string | null;
  resolved: number;
  quantity: number;
  unit: string;
  expires_on: string | null;
  purchased_on: string | null;
  notes: string | null;
  pending?: boolean;
}

export interface ShoppingItem {
  id: number | string;
  client_id?: string | null;
  name: string;
  quantity: number;
  unit: string;
  checked: number;
  pending?: boolean;
}

export interface LocationRef {
  id: number;
  name: string;
}

const EPS = 1e-9;

// Applies queued (not yet synced) operations on top of the last-known server state so the UI
// shows what the user just did, online or offline.
export function overlayLots(server: Lot[], ops: QueuedOp[], householdId: number, locations: LocationRef[], knownNames: Map<string, string>): Lot[] {
  const lots: Lot[] = server.map((l) => ({ ...l }));
  const find = (p: Record<string, unknown>) =>
    lots.findIndex((l) => (p.lot_id !== undefined && l.id === p.lot_id) || (p.lot_client_id !== undefined && l.client_id === p.lot_client_id));

  for (const op of ops) {
    if (op.household_id !== householdId || op.status !== "pending") continue;
    const p = op.payload;
    if (op.type === "lot.add") {
      if (lots.some((l) => l.client_id === op.client_id)) continue; // already on the server
      const barcode = (p.barcode as string | undefined) ?? null;
      const name = (p.name as string | undefined) || (barcode && knownNames.get(barcode)) || barcode || "Unnamed item";
      lots.push({
        id: `c:${op.client_id}`,
        client_id: op.client_id,
        location_id: Number(p.location_id),
        location_name: locations.find((l) => l.id === p.location_id)?.name ?? "",
        name,
        brand: (p.brand as string | undefined) ?? null,
        image_url: (p.image_url as string | undefined) ?? null,
        barcode,
        resolved: p.name || (barcode && knownNames.has(barcode)) ? 1 : 0,
        quantity: Number(p.quantity),
        unit: String(p.unit ?? "item"),
        expires_on: (p.expires_on as string | undefined) ?? null,
        purchased_on: (p.purchased_on as string | undefined) ?? null,
        notes: (p.notes as string | undefined) ?? null,
        pending: true,
      });
    } else if (op.type === "lot.consume") {
      const i = find(p);
      if (i < 0) continue;
      const left = lots[i]!.quantity - Number(p.amount ?? 1);
      if (left <= EPS) lots.splice(i, 1);
      else lots[i] = { ...lots[i]!, quantity: left, pending: true };
    } else if (op.type === "lot.move") {
      const i = find(p);
      if (i < 0) continue;
      lots[i] = { ...lots[i]!, location_id: Number(p.location_id), location_name: locations.find((l) => l.id === p.location_id)?.name ?? lots[i]!.location_name, pending: true };
    }
  }
  return lots.sort((a, b) => (a.expires_on === null ? 1 : 0) - (b.expires_on === null ? 1 : 0) || (a.expires_on ?? "").localeCompare(b.expires_on ?? "") || a.name.localeCompare(b.name));
}

export function overlayShopping(server: ShoppingItem[], ops: QueuedOp[], householdId: number): ShoppingItem[] {
  const items = server.map((i) => ({ ...i }));
  const find = (p: Record<string, unknown>) =>
    items.findIndex((i) => (p.item_id !== undefined && i.id === p.item_id) || (p.item_client_id !== undefined && i.client_id === p.item_client_id));
  for (const op of ops) {
    if (op.household_id !== householdId || op.status !== "pending") continue;
    const p = op.payload;
    if (op.type === "shopping.add") {
      if (!items.some((i) => i.client_id === op.client_id)) items.push({ id: `c:${op.client_id}`, client_id: op.client_id, name: String(p.name), quantity: Number(p.quantity ?? 1), unit: String(p.unit ?? "item"), checked: 0, pending: true });
    } else if (op.type === "shopping.toggle") {
      const i = find(p);
      if (i >= 0) items[i] = { ...items[i]!, checked: items[i]!.checked ? 0 : 1, pending: true };
    } else if (op.type === "shopping.delete") {
      const i = find(p);
      if (i >= 0) items.splice(i, 1);
    }
  }
  return items.sort((a, b) => a.checked - b.checked);
}
