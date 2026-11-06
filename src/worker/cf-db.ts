import type { Db, Stmt } from "../server/db-core.ts";

// Db on top of a SQLite-backed Durable Object. Its SQL API is synchronous and the object runs one request at
// a time, so the server code needs no async rewrite and its transactions mean what they do on node:sqlite.
export class DurableObjectDb implements Db {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;
  #depth = 0;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
    // PRAGMA user_version is not allowed in a Durable Object, so the schema version lives in a table.
    this.#sql.exec("CREATE TABLE IF NOT EXISTS shelfie_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  }

  prepare(query: string): Stmt {
    const sql = this.#sql;
    return {
      get: (...p) => {
        const r = sql.exec(query, ...p).next();
        return r.done ? undefined : r.value;
      },
      all: (...p) => sql.exec(query, ...p).toArray(),
      run: (...p) => {
        sql.exec(query, ...p).toArray();
        const r = sql.exec("SELECT changes() AS changes, last_insert_rowid() AS id").one() as { changes: number; id: number };
        return { changes: r.changes, lastInsertRowid: r.id };
      },
    };
  }

  exec(query: string): void {
    this.#sql.exec(query);
  }

  // BEGIN/COMMIT are rejected here; transactionSync commits when fn returns and rolls back when it throws.
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#depth++;
    try {
      return this.#storage.transactionSync(fn);
    } finally {
      this.#depth--;
    }
  }

  schemaVersion(): number {
    const r = this.#sql.exec("SELECT v FROM shelfie_meta WHERE k = 'schema_version'").toArray()[0] as { v: number } | undefined;
    return r?.v ?? 0;
  }

  sizeBytes(): number {
    return this.#sql.databaseSize;
  }

  setSchemaVersion(version: number): void {
    this.#sql.exec("INSERT INTO shelfie_meta(k,v) VALUES ('schema_version',?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", version);
  }
}
