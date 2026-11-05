import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { DatabaseSync } from "node:sqlite";
import type { Ctx, Env } from "./context.ts";
import { HttpError } from "./context.ts";
import { registerAuthRoutes } from "./routes-auth.ts";
import { makeWebPushSender } from "./push.ts";
import { registerInventoryRoutes } from "./routes-inventory.ts";
import { registerPushRoutes } from "./routes-push.ts";
import { registerSyncRoutes } from "./routes-sync.ts";
import { serveSpa } from "./static.ts";

export const VERSION = "0.3.0";

export interface AppOptions {
  // Directory of the built frontend. When omitted the app is API-only.
  staticRoot?: string;
  setupToken?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  defaultTargets?: { ntfy?: string; webhook?: string };
  sendPush?: Ctx["sendPush"];
}

export function createApp(db: DatabaseSync, options: AppOptions = {}) {
  const ctx: Ctx = {
    db,
    setupToken: options.setupToken,
    now: options.now ?? (() => new Date()),
    fetch: options.fetch ?? fetch,
    defaultTargets: options.defaultTargets ?? {},
    sendPush: options.sendPush ?? makeWebPushSender(db, process.env.SHELFIE_VAPID_SUBJECT ?? "mailto:admin@shelfie.local"),
    userAgent: process.env.OFF_USER_AGENT ?? `Shelfie/${VERSION} (self-hosted pantry tracker)`,
  };
  const app = new Hono<Env>();

  // Reject cross-site writes: a browser always sends Origin on cross-origin POSTs.
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && c.req.method !== "GET" && c.req.method !== "HEAD") {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {}
      const expected = c.req.header("x-forwarded-host") ?? c.req.header("host");
      if (host !== expected) throw new HttpError(403, "Cross-origin request blocked");
    }
    await next();
  });

  app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

  app.get("/api/health", (c) => {
    db.prepare("SELECT 1").get();
    return c.json({ ok: true, version: VERSION });
  });

  registerAuthRoutes(app, ctx);
  registerInventoryRoutes(app, ctx);
  registerSyncRoutes(app, ctx);
  registerPushRoutes(app, ctx);

  // Unknown API paths must never fall through to the SPA shell.
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (options.staticRoot) app.use("*", serveSpa(options.staticRoot));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  return Object.assign(app, { ctx });
}
