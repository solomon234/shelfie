import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${migrations.length}). Upgrade Shelfie.`,
    );
  }
  for (let i = current; i < migrations.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function openDb(path: string, migrations: readonly string[] = MIGRATIONS): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db, migrations);
  return db;
}
