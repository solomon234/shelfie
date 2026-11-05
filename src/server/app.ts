import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { DatabaseSync } from "node:sqlite";
import { serveSpa } from "./static.ts";

export const VERSION = "0.1.0";

export interface AppOptions {
  // Directory of the built frontend. When omitted the app is API-only.
  staticRoot?: string;
}

export function createApp(db: DatabaseSync, options: AppOptions = {}) {
  const app = new Hono();

  app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

  app.get("/api/health", (c) => {
    db.prepare("SELECT 1").get();
    return c.json({ ok: true, version: VERSION });
  });

  // Unknown API paths must never fall through to the SPA shell.
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (options.staticRoot) app.use("*", serveSpa(options.staticRoot));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}
