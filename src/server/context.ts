import type { DatabaseSync } from "node:sqlite";

export interface Ctx {
  db: DatabaseSync;
  setupToken?: string;
  now: () => Date;
  fetch: typeof fetch;
  userAgent: string;
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
