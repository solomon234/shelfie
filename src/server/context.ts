import type { DatabaseSync } from "node:sqlite";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// 'gone' means the push service says the subscription no longer exists and it should be deleted.
export type PushSender = (target: PushTarget, payload: string) => Promise<"ok" | "gone" | "error">;

export interface Ctx {
  db: DatabaseSync;
  setupToken?: string;
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
