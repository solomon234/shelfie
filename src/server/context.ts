import type { Db } from "./db-core.ts";

export type PasswordMode = "server" | "client";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// 'gone' means the push service says the subscription no longer exists and it should be deleted.
export type PushSender = (target: PushTarget, payload: string) => Promise<"ok" | "gone" | "error">;

export interface Ctx {
  db: Db;
  setupToken?: string;
  // "server": the browser sends the password and the server hashes it with scrypt (self-hosted default).
  // "client": the browser stretches it first (PBKDF2) and the server only stores a salted hash of that, which
  // keeps login cheap enough for runtimes with a tiny CPU budget (Cloudflare Workers).
  passwordMode: PasswordMode;
  now: () => Date;
  fetch: typeof fetch;
  userAgent: string;
  defaultTargets: { ntfy?: string; webhook?: string };
  sendPush: PushSender;
}

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
}

export type Env = { Variables: { user: User } };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
