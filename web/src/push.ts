import { ApiError, api } from "./api.ts";

export type PushState = "unsupported" | "denied" | "off" | "on";

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  // The service worker is only registered in production builds.
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  const reg = await registration();
  if (!reg) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return (await reg.pushManager.getSubscription()) && Notification.permission === "granted" ? "on" : "off";
}

async function sendToServer(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  await api("/api/push/subscribe", { method: "POST", body: { endpoint: json.endpoint, keys: json.keys } });
}

export async function enablePush(): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error("Notifications are not supported here. Open the installed app over HTTPS.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked. Allow them in the browser's site settings.");
  const { public_key } = await api<{ public_key: string }>("/api/push/key");
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(public_key) }));
  await sendToServer(sub);
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

// Keeps the server's copy fresh (it may have been pruned or the keys rotated); safe to call on every sign-in.
export async function resyncPush(): Promise<void> {
  try {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub && Notification.permission === "granted") await sendToServer(sub);
  } catch (e) {
    if (!(e instanceof ApiError)) return; // offline or unsupported: nothing to do
  }
}

export const sendTestPush = () => api<{ sent: number; attempted: number }>("/api/push/test", { method: "POST" });
