import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

const dbPath = process.env.SHELFIE_DB ?? "./data/shelfie.db";
const port = Number(process.env.PORT ?? 8787);

mkdirSync(dirname(dbPath), { recursive: true });
const app = createApp(openDb(dbPath));

app.use("/*", serveStatic({ root: "./dist/web" }));
app.get("*", serveStatic({ path: "./dist/web/index.html" }));

serve({ fetch: app.fetch, port }, () => console.log(`shelfie listening on :${port}`));
