import type { Notice, QueuedOp, Store } from "./store.ts";

export const BATCH = 200;

export interface ReplayResult {
  applied: number;
  remaining: number;
  offline: boolean;
  unauthorized: boolean;
}

interface OpResult {
  client_id: string | null;
  status: "applied" | "duplicate" | "gone" | "invalid" | "retry";
  error?: string;
  floored?: boolean;
}

export interface SyncDeps {
  store: Store;
  fetch: typeof fetch;
  now?: () => Date;
}

const label = (op: QueuedOp) => String(op.payload.label ?? "an item");

async function addNotice(store: Store, text: string, at: Date): Promise<void> {
  const list = (await store.kvGet<Notice[]>("notices")) ?? [];
  list.push({ id: crypto.randomUUID(), text, at: at.toISOString() });
  await store.kvSet("notices", list.slice(-20));
}

let inFlight: Promise<ReplayResult> | null = null;

// Replays pending operations in order. Safe to call repeatedly: one replay runs at a time, and the
// server de-duplicates by client_id, so an interrupted replay can simply be run again.
export function replay(deps: SyncDeps): Promise<ReplayResult> {
  if (inFlight) return inFlight;
  const run = doReplay(deps).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

async function doReplay({ store, fetch: f, now = () => new Date() }: SyncDeps): Promise<ReplayResult> {
  const out: ReplayResult = { applied: 0, remaining: 0, offline: false, unauthorized: false };
  const ops = (await store.listOps()).filter((o) => o.status === "pending");

  let i = 0;
  while (i < ops.length) {
    // One request per run of consecutive ops for the same household, preserving global order.
    const hid = ops[i]!.household_id;
    let j = i;
    while (j < ops.length && ops[j]!.household_id === hid && j - i < BATCH) j++;
    const batch = ops.slice(i, j);

    let res: Response;
    try {
      res = await f(`/api/households/${hid}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: batch.map((o) => ({ ...o.payload, type: o.type, client_id: o.client_id })) }),
      });
    } catch {
      out.offline = true;
      break;
    }
    if (res.status === 401) {
      out.unauthorized = true;
      break;
    }
    if (res.status === 404) {
      for (const o of batch) await store.updateOp({ ...o, status: "invalid", error: "This household is no longer available" });
      i = j;
      continue;
    }
    if (!res.ok) {
      out.offline = true; // server trouble: keep everything and try again later
      break;
    }
    const { results } = (await res.json()) as { results: OpResult[] };
    for (let k = 0; k < batch.length; k++) {
      const op = batch[k]!;
      const r = results[k];
      if (!r || r.status === "retry") {
        await store.updateOp({ ...op, attempts: op.attempts + 1 });
        continue;
      }
      if (r.status === "invalid") {
        await store.updateOp({ ...op, status: "invalid", error: r.error ?? "Rejected by the server" });
        continue;
      }
      await store.removeOp(op.seq!);
      out.applied++;
      if (r.status === "gone" && op.type === "lot.consume") await addNotice(store, `${label(op)} was already used up elsewhere.`, now());
      else if (r.floored) await addNotice(store, `${label(op)}: you used more than was left, so it is now gone.`, now());
    }
    i = j;
  }

  out.remaining = (await store.listOps()).filter((o) => o.status === "pending").length;
  return out;
}
