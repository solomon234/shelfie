import { DatabaseSync } from "node:sqlite";
import { migrate, type Db, type Stmt } from "./db-core.ts";
import { MIGRATIONS } from "./migrations.ts";

export * from "./db-core.ts";

export class NodeDb implements Db {
  readonly raw: DatabaseSync;
  #depth = 0;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  prepare(sql: string): Stmt {
    const s = this.raw.prepare(sql);
    return {
      get: (...p) => s.get(...p),
      all: (...p) => s.all(...p),
      run: (...p) => s.run(...p),
    };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.#depth++;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.#depth--;
    }
  }

  schemaVersion(): number {
    return (this.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  setSchemaVersion(version: number): void {
    this.raw.exec(`PRAGMA user_version = ${version}`);
  }

  sizeBytes(): number {
    const n = (pragma: string) => Object.values(this.raw.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[0]!;
    return n("page_count") * n("page_size");
  }

  close(): void {
    this.raw.close();
  }
}

export function openDb(path: string, migrations: readonly string[] = MIGRATIONS): NodeDb {
  const db = new NodeDb(new DatabaseSync(path));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db, migrations);
  return db;
}
