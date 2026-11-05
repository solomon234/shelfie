import type { Ctx } from "./context.ts";
import { daysBetween, localParts } from "./dates.ts";

interface HouseholdRow {
  id: number;
  name: string;
  timezone: string;
  expiry_warning_days: number;
  alert_hour: number;
  ntfy_url: string | null;
  webhook_url: string | null;
  last_alert_on: string | null;
}

export interface AlertItem {
  lot_id: number;
  name: string;
  quantity: number;
  unit: string;
  expires_on: string;
  days: number;
  location: string;
}

export interface Targets {
  ntfy: string | null;
  webhook: string | null;
}

export function targetsFor(ctx: Ctx, h: Pick<HouseholdRow, "ntfy_url" | "webhook_url">): Targets {
  return { ntfy: h.ntfy_url ?? ctx.defaultTargets.ntfy ?? null, webhook: h.webhook_url ?? ctx.defaultTargets.webhook ?? null };
}

const fmt = (i: AlertItem) => `${i.name} (${i.quantity} ${i.unit})`;

function message(h: { name: string }, expired: AlertItem[], warning: AlertItem[]): { title: string; body: string; priority: string } {
  const lines: string[] = [];
  if (expired.length) lines.push(`Expired: ${expired.map(fmt).join(", ")}`);
  if (warning.length) lines.push(`Expiring soon: ${warning.map((i) => `${fmt(i)} ${i.days === 0 ? "today" : `in ${i.days}d`}`).join(", ")}`);
  const n = expired.length + warning.length;
  return { title: `Shelfie: ${n} item${n === 1 ? "" : "s"} need attention (${h.name})`.replace(/[^\x20-\x7e]/g, "?"), body: lines.join("\n"), priority: expired.length ? "high" : "default" };
}

async function post(ctx: Ctx, url: string, init: RequestInit): Promise<boolean> {
  try {
    const res = await ctx.fetch(url, { ...init, method: "POST", signal: AbortSignal.timeout(8000) });
    if (!res.ok) console.error(`shelfie: alert target responded ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`shelfie: alert delivery failed: ${(e as Error).message}`);
    return false;
  }
}

// Sends to every configured target; true when at least one accepted it.
export async function deliver(ctx: Ctx, h: { name: string }, targets: Targets, expired: AlertItem[], warning: AlertItem[], date: string): Promise<boolean> {
  const m = message(h, expired, warning);
  const results: boolean[] = [];
  if (targets.ntfy) {
    results.push(await post(ctx, targets.ntfy, { headers: { Title: m.title, Priority: m.priority, Tags: expired.length ? "warning" : "hourglass", "User-Agent": ctx.userAgent }, body: m.body }));
  }
  if (targets.webhook) {
    results.push(await post(ctx, targets.webhook, { headers: { "Content-Type": "application/json", "User-Agent": ctx.userAgent }, body: JSON.stringify({ household: h.name, date, title: m.title, expired, warning }) }));
  }
  return results.some(Boolean);
}

export async function sendTest(ctx: Ctx, householdId: number): Promise<{ sent: boolean; targets: number }> {
  const h = ctx.db.prepare("SELECT * FROM households WHERE id = ?").get(householdId) as unknown as HouseholdRow;
  const t = targetsFor(ctx, h);
  const sample: AlertItem = { lot_id: 0, name: "Test item", quantity: 1, unit: "item", expires_on: localParts(ctx.now(), h.timezone).date, days: 0, location: "Pantry" };
  const sent = await deliver(ctx, h, t, [], [sample], sample.expires_on);
  return { sent, targets: Number(Boolean(t.ntfy)) + Number(Boolean(t.webhook)) };
}

// Each lot is alerted once per transition: entering the warning window, then becoming expired.
export async function runAlertCheck(ctx: Ctx): Promise<{ households: number; alerted: number }> {
  const households = ctx.db.prepare("SELECT * FROM households").all() as unknown as HouseholdRow[];
  let alerted = 0;
  for (const h of households) {
    const local = localParts(ctx.now(), h.timezone);
    if (local.hour < h.alert_hour || h.last_alert_on === local.date) continue;
    const targets = targetsFor(ctx, h);
    if (!targets.ntfy && !targets.webhook) continue;

    const cutoff = new Date(Date.parse(local.date + "T00:00:00Z") + h.expiry_warning_days * 86400_000).toISOString().slice(0, 10);
    const rows = ctx.db
      .prepare(
        `SELECT l.id AS lot_id, p.name, l.quantity, l.unit, l.expires_on, loc.name AS location
         FROM lots l JOIN products p ON p.id = l.product_id JOIN locations loc ON loc.id = l.location_id
         WHERE l.household_id = ? AND l.expires_on IS NOT NULL AND l.expires_on <= ?
         ORDER BY l.expires_on, p.name`,
      )
      .all(h.id, cutoff) as unknown as Omit<AlertItem, "days">[];

    const fresh: { item: AlertItem; state: "expired" | "warning" }[] = [];
    for (const r of rows) {
      const days = daysBetween(local.date, r.expires_on);
      const state = days < 0 ? "expired" : "warning";
      const done = ctx.db.prepare("SELECT 1 FROM alert_state WHERE lot_id = ? AND state = ?").get(r.lot_id, state);
      if (!done) fresh.push({ item: { ...r, days }, state });
    }

    if (fresh.length) {
      const ok = await deliver(ctx, h, targets, fresh.filter((f) => f.state === "expired").map((f) => f.item), fresh.filter((f) => f.state === "warning").map((f) => f.item), local.date);
      if (!ok) continue; // not recorded: the next run retries
      const mark = ctx.db.prepare("INSERT OR IGNORE INTO alert_state(lot_id,state) VALUES (?,?)");
      for (const f of fresh) mark.run(f.item.lot_id, f.state);
      alerted += fresh.length;
    }
    ctx.db.prepare("UPDATE households SET last_alert_on = ? WHERE id = ?").run(local.date, h.id);
  }
  return { households: households.length, alerted };
}

export function startAlertScheduler(ctx: Ctx, everyMs = 5 * 60_000): NodeJS.Timeout {
  const tick = () => runAlertCheck(ctx).catch((e) => console.error("shelfie: alert check failed", e));
  setTimeout(tick, 15_000).unref();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return timer;
}
