import { DurableObject } from "cloudflare:workers";
import { runBackgroundChecks } from "../server/alerts.ts";
import { createApp } from "../server/app.ts";
import { migrate } from "../server/db-core.ts";
import { DurableObjectDb } from "./cf-db.ts";

export interface Env {
  SHELFIE: DurableObjectNamespace<Shelfie>;
  SHELFIE_SETUP_TOKEN?: string;
  SHELFIE_VAPID_SUBJECT?: string;
  SHELFIE_NTFY_URL?: string;
  SHELFIE_WEBHOOK_URL?: string;
}

const BACKGROUND_EVERY_MS = 5 * 60_000;

// One Durable Object holds the whole database, which is plenty for a handful of households and keeps every
// request serialized. The static frontend is served by Workers Assets and never reaches this code.
export class Shelfie extends DurableObject<Env> {
  readonly #app: ReturnType<typeof createApp>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = new DurableObjectDb(ctx.storage);
    migrate(db);
    this.#app = createApp(db, {
      setupToken: env.SHELFIE_SETUP_TOKEN,
      passwordMode: "client",
      vapidSubject: env.SHELFIE_VAPID_SUBJECT,
      defaultTargets: { ntfy: env.SHELFIE_NTFY_URL, webhook: env.SHELFIE_WEBHOOK_URL },
    });
  }

  async fetch(request: Request): Promise<Response> {
    // Expiry alerts need a wake-up even when nobody opens the app; an alarm replaces the Node timer.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 15_000);
    return this.#app.fetch(request);
  }

  async alarm(): Promise<void> {
    await runBackgroundChecks(this.#app.ctx);
    await this.ctx.storage.setAlarm(Date.now() + BACKGROUND_EVERY_MS);
  }
}

export default {
  fetch: (request, env) => env.SHELFIE.get(env.SHELFIE.idFromName("main")).fetch(request),
} satisfies ExportedHandler<Env>;
