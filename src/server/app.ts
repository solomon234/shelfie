import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";

export function createApp(db: DatabaseSync) {
  const app = new Hono();

  app.get("/api/health", (c) => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return c.json({ ok: true, first_run: n === 0 });
  });

  return app;
}
