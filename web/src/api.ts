import { createStore, type Store } from "./store.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export class NetworkError extends Error {}

export const store: Store = createStore();

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new NetworkError("You appear to be offline");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return data as T;
}

// GET with a persisted fallback so the app still shows last-known data with no connection.
export async function cachedGet<T>(path: string): Promise<{ data: T | undefined; stale: boolean }> {
  try {
    const data = await api<T>(path);
    await store.cacheSet(path, data);
    return { data, stale: false };
  } catch (e) {
    if (e instanceof NetworkError) return { data: await store.cacheGet<T>(path), stale: true };
    throw e;
  }
}
