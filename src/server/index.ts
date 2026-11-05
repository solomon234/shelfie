import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

function fail(message: string): never {
  console.error(`shelfie: ${message}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT must be an integer from 1 to 65535 (got "${process.env.PORT}")`);

const dbPath = process.env.SHELFIE_DB ?? "./data/shelfie.db";
const dbDir = dirname(resolve(dbPath));
try {
  mkdirSync(dbDir, { recursive: true });
  accessSync(dbDir, constants.W_OK);
} catch {
  fail(`data directory ${dbDir} is not writable by uid ${process.getuid?.() ?? "?"}; fix its ownership or permissions`);
}

const staticRoot = resolve(process.env.SHELFIE_WEB_DIR ?? "./dist/web");
const apiOnly = process.env.SHELFIE_API_ONLY === "1";
if (!apiOnly && !existsSync(resolve(staticRoot, "index.html"))) {
  fail(`built frontend not found at ${staticRoot}; run "npm run build" (or set SHELFIE_API_ONLY=1)`);
}

const db = openDb(dbPath);
const app = createApp(db, { staticRoot: apiOnly ? undefined : staticRoot, setupToken: process.env.SHELFIE_SETUP_TOKEN });

const server = serve({ fetch: app.fetch, port }, () => console.log(`shelfie listening on :${port}`));

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
