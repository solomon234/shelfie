// IndexedDB persistence: the offline outbox, a read cache for API responses, and small key/value state.
export type OpType = "lot.add" | "lot.consume" | "lot.move" | "shopping.add" | "shopping.toggle" | "shopping.delete";

export interface QueuedOp {
  seq?: number;
  household_id: number;
  client_id: string;
  type: OpType;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
  status: "pending" | "invalid";
  error?: string;
}

export interface Notice {
  id: string;
  text: string;
  at: string;
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export interface Store {
  enqueue(op: Omit<QueuedOp, "seq" | "attempts" | "status" | "created_at"> & Partial<QueuedOp>): Promise<number>;
  listOps(): Promise<QueuedOp[]>;
  removeOp(seq: number): Promise<void>;
  updateOp(op: QueuedOp): Promise<void>;
  clearOps(): Promise<void>;
  cacheGet<T>(key: string): Promise<T | undefined>;
  cacheSet(key: string, value: unknown): Promise<void>;
  kvGet<T>(key: string): Promise<T | undefined>;
  kvSet(key: string, value: unknown): Promise<void>;
  clearAll(): Promise<void>;
}

export function createStore(factory?: IDBFactory, name = "shelfie"): Store {
  // Opened on first use, so importing this module never touches IndexedDB (it does not exist in Node).
  let opened: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = (factory ?? indexedDB).open(name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
        db.createObjectStore("cache", { keyPath: "key" });
        db.createObjectStore("kv", { keyPath: "key" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const store = async (s: string, mode: IDBTransactionMode) => (await open()).transaction(s, mode).objectStore(s);

  return {
    async enqueue(op) {
      const rec = { attempts: 0, status: "pending", created_at: new Date().toISOString(), ...op } as QueuedOp;
      return (await req((await store("outbox", "readwrite")).add(rec))) as number;
    },
    async listOps() {
      const all = (await req((await store("outbox", "readonly")).getAll())) as QueuedOp[];
      return all.sort((a, b) => a.seq! - b.seq!);
    },
    async removeOp(seq) {
      await req((await store("outbox", "readwrite")).delete(seq));
    },
    async updateOp(op) {
      await req((await store("outbox", "readwrite")).put(op));
    },
    async clearOps() {
      await req((await store("outbox", "readwrite")).clear());
    },
    async cacheGet<T>(key: string) {
      return ((await req((await store("cache", "readonly")).get(key))) as { value: T } | undefined)?.value;
    },
    async cacheSet(key, value) {
      await req((await store("cache", "readwrite")).put({ key, value, at: Date.now() }));
    },
    async kvGet<T>(key: string) {
      return ((await req((await store("kv", "readonly")).get(key))) as { value: T } | undefined)?.value;
    },
    async kvSet(key, value) {
      await req((await store("kv", "readwrite")).put({ key, value }));
    },
    async clearAll() {
      for (const s of ["outbox", "cache", "kv"]) await req((await store(s, "readwrite")).clear());
    },
  };
}
