import { randomBytes } from "node:crypto";
import webpush from "web-push";
import type { Ctx, PushSender } from "./context.ts";
import type { Db } from "./db-core.ts";

// The server POSTs to whatever endpoint a device registers, so only real push services are accepted.
// Otherwise a household member could point the server at an address on the home network.
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  ".push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
];

export function isPushEndpoint(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  return PUSH_HOSTS.some((h) => (h.startsWith(".") ? u.hostname.endsWith(h) : u.hostname === h));
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// Generated once and kept in the database, so devices stay subscribed across restarts and upgrades.
export function vapidKeys(db: Db): VapidKeys {
  const get = (k: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const publicKey = get("vapid_public");
  const privateKey = get("vapid_private");
  if (publicKey && privateKey) return { publicKey, privateKey };
  const fresh = webpush.generateVAPIDKeys();
  const put = db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)");
  put.run("vapid_public", fresh.publicKey);
  put.run("vapid_private", fresh.privateKey);
  return fresh;
}

export function makeWebPushSender(db: Db, subject: string): PushSender {
  let keys: VapidKeys | undefined;
  return async (target, payload) => {
    keys ??= vapidKeys(db);
    try {
      await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
        vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 86400,
        urgency: "high",
        timeout: 10_000,
      });
      return "ok";
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return "gone";
      console.error(`shelfie: push failed${status ? ` (${status})` : ""}: ${(e as Error).message}`);
      return "error";
    }
  };
}

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

export interface PushResult {
  attempted: number;
  sent: number;
}

async function pushTo(ctx: Ctx, rows: { id: number; endpoint: string; p256dh: string; auth: string }[], payload: PushPayload): Promise<PushResult> {
  const text = JSON.stringify(payload);
  const results = await Promise.all(rows.map((r) => ctx.sendPush({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, text)));
  results.forEach((res, i) => {
    if (res === "gone") ctx.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(rows[i]!.id);
  });
  return { attempted: rows.length, sent: results.filter((r) => r === "ok").length };
}

export function householdDevices(ctx: Ctx, householdId: number) {
  return ctx.db
    .prepare(
      `SELECT DISTINCT ps.id, ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
       JOIN memberships m ON m.user_id = ps.user_id WHERE m.household_id = ?`,
    )
    .all(householdId) as { id: number; endpoint: string; p256dh: string; auth: string }[];
}

export const pushToHousehold = (ctx: Ctx, householdId: number, payload: PushPayload) => pushTo(ctx, householdDevices(ctx, householdId), payload);

export function pushToUser(ctx: Ctx, userId: number, payload: PushPayload) {
  const rows = ctx.db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").all(userId) as {
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }[];
  return pushTo(ctx, rows, payload);
}

export const newTag = () => randomBytes(4).toString("hex");
