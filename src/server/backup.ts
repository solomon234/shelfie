import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export interface BackupResult {
  file: string;
  pruned: string[];
}

// Uses SQLite's online backup API, so it is consistent while the server is writing (a plain file
// copy of a WAL database is not). The copy is verified before older backups are pruned.
export async function backupDatabase(source: string, destDir: string, keep = 14, now = new Date()): Promise<BackupResult> {
  mkdirSync(destDir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const file = join(destDir, `shelfie-${stamp}.db`);
  const src = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(src, file);
  } finally {
    src.close();
  }
  // The copy inherits WAL mode; switch it to a single self-contained file before verifying.
  const copy = new DatabaseSync(file);
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
    const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (check.integrity_check !== "ok") throw new Error(`backup failed integrity check: ${check.integrity_check}`);
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  } finally {
    copy.close();
  }
  const all = readdirSync(destDir).filter((f) => /^shelfie-\d{8}-\d{6}\.db$/.test(f)).sort();
  const pruned = all.slice(0, Math.max(0, all.length - keep));
  for (const f of pruned) rmSync(join(destDir, f), { force: true });
  return { file, pruned };
}

if (import.meta.main) {
  const source = process.env.SHELFIE_DB ?? "./data/shelfie.db";
  const dest = process.argv[2] ?? "/data/backups";
  backupDatabase(source, dest, Number(process.env.SHELFIE_BACKUP_KEEP ?? 14))
    .then((r) => console.log(`backup written: ${r.file}${r.pruned.length ? ` (pruned ${r.pruned.length})` : ""}`))
    .catch((e) => {
      console.error(`shelfie backup failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
