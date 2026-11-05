import { useEffect, useState } from "preact/hooks";
import { localParts, daysBetween } from "../../src/shared/dates.ts";
import { ApiError, NetworkError, api, cachedGet, store } from "./api.ts";
import { overlayLots, overlayShopping, type Lot, type LocationRef, type ShoppingItem } from "./overlay.ts";
import type { Notice, OpType, QueuedOp } from "./store.ts";
import { resyncPush } from "./push.ts";
import { replay } from "./sync.ts";

export interface Household {
  id: number;
  name: string;
  role: "owner" | "member";
  timezone: string;
  expiry_warning_days: number;
  alert_hour: number;
  ntfy_url: string | null;
  webhook_url: string | null;
}
export interface Me {
  id: number;
  username: string;
  is_admin: boolean;
  households: Household[];
}

export interface AppState {
  phase: "loading" | "auth" | "ready";
  me: Me | null;
  householdId: number | null;
  online: boolean;
  stale: boolean;
  syncing: boolean;
  lastSynced: string | null;
  locations: LocationRef[];
  serverLots: Lot[];
  serverShopping: ShoppingItem[];
  ops: QueuedOp[];
  notices: Notice[];
  names: Record<string, string>;
  toast: string | null;
}

let state: AppState = {
  phase: "loading",
  me: null,
  householdId: null,
  online: true,
  stale: false,
  syncing: false,
  lastSynced: null,
  locations: [],
  serverLots: [],
  serverShopping: [],
  ops: [],
  notices: [],
  names: {},
  toast: null,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<AppState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
export const getState = () => state;
export function useApp(): AppState {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string): void {
  set({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), 3500);
}
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const household = (s: AppState = state): Household | undefined => s.me?.households.find((h) => h.id === s.householdId);

async function loadOps(): Promise<void> {
  set({ ops: await store.listOps(), notices: (await store.kvGet<Notice[]>("notices")) ?? [] });
}

async function loadHousehold(): Promise<void> {
  const hid = state.householdId;
  if (!hid) return;
  const [locs, inv, shop] = await Promise.all([
    cachedGet<LocationRef[]>(`/api/households/${hid}/locations`),
    cachedGet<Lot[]>(`/api/households/${hid}/inventory`),
    cachedGet<ShoppingItem[]>(`/api/households/${hid}/shopping`),
  ]);
  const names = { ...state.names };
  for (const l of inv.data ?? []) if (l.barcode && l.resolved) names[l.barcode] = l.name;
  set({
    locations: locs.data ?? [],
    serverLots: inv.data ?? [],
    serverShopping: shop.data ?? [],
    stale: inv.stale || shop.stale,
    online: !(inv.stale || shop.stale),
    names,
    lastSynced: inv.stale ? state.lastSynced : new Date().toISOString(),
  });
  if (!inv.stale) await store.kvSet("names", names);
}

export async function syncNow(): Promise<void> {
  if (state.syncing || state.phase !== "ready") return;
  set({ syncing: true });
  try {
    const r = await replay({ store, fetch: (u, i) => fetch(u, { ...i, credentials: "same-origin" }) });
    if (r.unauthorized) {
      set({ phase: "auth" });
      return;
    }
    await loadOps();
    if (!r.offline) await loadHousehold();
    else set({ online: false });
  } finally {
    set({ syncing: false });
  }
}

export async function refresh(): Promise<void> {
  await loadOps();
  if (state.ops.some((o) => o.status === "pending")) return syncNow();
  try {
    await loadHousehold();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) set({ phase: "auth" });
    else throw e;
  }
}

async function enter(me: Me): Promise<void> {
  const saved = Number(await store.kvGet<number>("householdId"));
  const hid = me.households.find((h) => h.id === saved)?.id ?? me.households[0]?.id ?? null;
  set({ me, householdId: hid, phase: "ready", names: (await store.kvGet<Record<string, string>>("names")) ?? {} });
  await refresh();
  void import("./scanner.tsx"); // warm the scanner chunk so scanning works offline later
  void resyncPush();
}

export async function boot(): Promise<void> {
  try {
    const me = await api<Me>("/api/me");
    await store.cacheSet("/api/me", me);
    await enter(me);
  } catch (e) {
    if (e instanceof NetworkError) {
      const cached = await store.cacheGet<Me>("/api/me");
      if (cached) {
        set({ online: false });
        return enter(cached);
      }
      set({ phase: "auth", online: false });
    } else set({ phase: "auth" });
  }
}

export async function signIn(path: "/api/login" | "/api/setup", body: Record<string, unknown>): Promise<void> {
  await api(path, { method: "POST", body });
  await boot();
}

export async function signOut(): Promise<void> {
  await syncNow().catch(() => {});
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* offline: the cookie is cleared by closing the session locally below */
  }
  await store.clearAll();
  set({ phase: "auth", me: null, householdId: null, ops: [], serverLots: [], serverShopping: [], notices: [] });
}

export async function selectHousehold(id: number): Promise<void> {
  await store.kvSet("householdId", id);
  set({ householdId: id, locations: [], serverLots: [], serverShopping: [] });
  await refresh();
}

export async function reloadMe(): Promise<void> {
  const me = await api<Me>("/api/me");
  await store.cacheSet("/api/me", me);
  set({ me });
}

// Every queueable write goes through the outbox, online or not: one code path, and the UI updates at once.
export async function enqueue(type: OpType, payload: Record<string, unknown>): Promise<string> {
  const hid = state.householdId!;
  const client_id = crypto.randomUUID();
  await store.enqueue({ household_id: hid, client_id, type, payload });
  await loadOps();
  void syncNow();
  return client_id;
}

export async function discardOp(seq: number): Promise<void> {
  await store.removeOp(seq);
  await loadOps();
}

export async function dismissNotice(id: string): Promise<void> {
  const list = ((await store.kvGet<Notice[]>("notices")) ?? []).filter((n) => n.id !== id);
  await store.kvSet("notices", list);
  await loadOps();
}

export function lots(s: AppState = state): Lot[] {
  return overlayLots(s.serverLots, s.ops, s.householdId ?? 0, s.locations, new Map(Object.entries(s.names)));
}
export function shopping(s: AppState = state): ShoppingItem[] {
  return overlayShopping(s.serverShopping, s.ops, s.householdId ?? 0);
}
export const pendingCount = (s: AppState = state) => s.ops.filter((o) => o.status === "pending").length;
export const invalidOps = (s: AppState = state) => s.ops.filter((o) => o.status === "invalid");

export function daysLeft(expires: string | null, h: Household | undefined): number | null {
  if (!expires) return null;
  return daysBetween(localParts(new Date(), h?.timezone ?? "UTC").date, expires);
}

export function summary(s: AppState = state) {
  const h = household(s);
  const all = lots(s);
  const dated = all.map((l) => ({ l, d: daysLeft(l.expires_on, h) })).filter((x): x is { l: Lot; d: number } => x.d !== null);
  return {
    items: all.reduce((n, l) => n + l.quantity, 0),
    expired: dated.filter((x) => x.d < 0).length,
    soon: dated.filter((x) => x.d >= 0 && x.d <= (h?.expiry_warning_days ?? 3)).length,
    expiring: dated.filter((x) => x.d <= 14).sort((a, b) => a.d - b.d),
    shopping: shopping(s).filter((i) => !i.checked).length,
  };
}

export function initLifecycle(): void {
  window.addEventListener("online", () => void syncNow());
  window.addEventListener("offline", () => set({ online: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.phase === "ready") void refresh();
  });
}
