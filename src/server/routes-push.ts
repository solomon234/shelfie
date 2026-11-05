import type { Hono } from "hono";
import type { Ctx, Env } from "./context.ts";
import { HttpError } from "./context.ts";
import { requireAuth } from "./auth.ts";
import { isPushEndpoint, newTag, pushToUser, vapidKeys } from "./push.ts";
import { readBody, str } from "./validate.ts";

export function registerPushRoutes(app: Hono<Env>, ctx: Ctx): void {
  const auth = requireAuth(ctx);

  app.get("/api/push/key", auth, (c) => c.json({ public_key: vapidKeys(ctx.db).publicKey }));

  app.post("/api/push/subscribe", auth, async (c) => {
    const body = await readBody(c);
    const endpoint = str(body, "endpoint", 1, 1000);
    if (!isPushEndpoint(endpoint)) throw new HttpError(400, "Not a supported push service endpoint");
    const keys = (typeof body.keys === "object" && body.keys !== null ? body.keys : {}) as Record<string, unknown>;
    const p256dh = str(keys, "p256dh", 1, 200);
    const authKey = str(keys, "auth", 1, 100);
    ctx.db
      .prepare(
        `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent) VALUES (?,?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      )
      .run(c.get("user").id, endpoint, p256dh, authKey, (c.req.header("user-agent") ?? "").slice(0, 200));
    return c.json({ ok: true });
  });

  app.post("/api/push/unsubscribe", auth, async (c) => {
    const body = await readBody(c);
    ctx.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(str(body, "endpoint", 1, 1000), c.get("user").id);
    return c.json({ ok: true });
  });

  // Sends a test notification to the signed-in user's own devices.
  app.post("/api/push/test", auth, async (c) => {
    const r = await pushToUser(ctx, c.get("user").id, {
      title: "Shelfie test",
      body: "Notifications are working on this device.",
      tag: `shelfie-test-${newTag()}`,
      url: "/",
    });
    if (!r.attempted) throw new HttpError(400, "No device is subscribed. Turn on notifications first.");
    return c.json(r, r.sent ? 200 : 502);
  });
}
