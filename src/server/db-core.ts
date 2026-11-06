import { MIGRATIONS } from "./migrations.ts";

export type Param = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Stmt {
  get(...params: Param[]): unknown;
  all(...params: Param[]): unknown[];
  run(...params: Param[]): RunResult;
}

// The slice of SQLite the server uses. `node:sqlite` backs self-hosting and the tests; a SQLite-backed
// Durable Object backs the Cloudflare Worker (see src/worker/cf-db.ts).
export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  // Runs fn atomically: commits when it returns, rolls back when it throws. Nested calls join the outer one.
  transaction<T>(fn: () => T): T;
  schemaVersion(): number;
  setSchemaVersion(version: number): void;
  // Bytes the database occupies, for the admin usage view.
  sizeBytes(): number;
}

export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): void {
  const current = db.schemaVersion();
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${migrations.length}). Upgrade Shelfie.`,
    );
  }
  for (let i = current; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]!);
      db.setSchemaVersion(i + 1);
    });
  }
}
