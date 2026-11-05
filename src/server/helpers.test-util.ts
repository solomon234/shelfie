import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import type { Env } from "./context.ts";

export const TOKEN = "test-setup-token";

export interface Client {
  app: Hono<Env>;
  cookie: string;
  req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
}

export function client(app: Hono<Env>): Client {
  const c: Client = {
    app,
    cookie: "",
    async req(method, path, body, headers = {}) {
      const res = await app.request(path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(c.cookie ? { cookie: c.cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) c.cookie = set.startsWith("shelfie_session=;") || /Max-Age=0/i.test(set) ? "" : set.split(";")[0]!;
      return res;
    },
    async json(method, path, body) {
      const res = await c.req(method, path, body);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
  return c;
}

export function testApp(opts: { now?: () => Date; fetch?: typeof fetch } = {}) {
  const db = openDb(":memory:");
  const app = createApp(db, { setupToken: TOKEN, ...opts });
  return { db, app, client: () => client(app) };
}

export async function setupInstance(c: Client, over: Record<string, unknown> = {}) {
  return c.json("POST", "/api/setup", {
    token: TOKEN,
    username: "admin",
    password: "correct horse",
    household_name: "Home",
    timezone: "America/New_York",
    ...over,
  });
}

// Sign a second user in as a fresh client.
export async function loginAs(t: ReturnType<typeof testApp>, username: string, password: string) {
  const c = t.client();
  const r = await c.json("POST", "/api/login", { username, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return c;
}
