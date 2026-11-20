import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseBackupName } from "./db-backup-paths.ts";
import { RETIRED_DIR_NAME, VAULT_FILE_ID, vaultFileName, vaultFilesDirFor } from "../vault/vault-files-dir.ts";

/**
 * The vault's encrypted files beside the database snapshots that name them.
 *
 * A snapshot is `VACUUM INTO` of the database alone, and the vault keeps its files outside it
 * (`vault-files/`). So after each snapshot the files it names are put into one shared folder beside
 * the snapshots (`<backups>/vault-files/`, `vault-files.dev/` for `ppm.dev.db`). A file is written
 * once and never changed, so it sits in that folder once however many snapshots name it, and is
 * hard-linked from the live folder where the two share a drive (no extra space), copied where not.
 * Retention removes a file there once no kept snapshot names it; a restore puts back the files
 * the restored snapshot names.
 *
 * The files hold ciphertext only. They open with the tier's password as it was when the snapshot
 * was taken: changing a password re-wraps the tier's key, not the files, so an older snapshot still
 * opens with the older password.
 *
 * Synchronous and free of `db.service` imports, like the rest of the backup core: it runs from the
 * pre-migration snapshot inside `getDb()`, from the supervisor and from `ppm backup`.
 */

export interface VaultFilesResult {
  /** Files the snapshot names that are now in the shared folder (already there or just added). */
  kept: number;
  /** Files the snapshot names that could not be found to keep. */
  missing: string[];
}

/** The shared folder beside snapshots of `dbFile` in `backupsDir`. */
export function backupVaultFilesDir(backupsDir: string, dbFile: string): string {
  return vaultFilesDirFor(join(backupsDir, basename(dbFile)));
}

/**
 * The file ids a snapshot (or any database file) names; none when it predates attachments.
 *
 * `withLog` reads a live database together with its write-ahead log, which a read-only open cannot
 * replay. It works on a copy of the file and its sidecars: opening the live one read-write would
 * checkpoint and remove its log, and a restore must leave the database it replaces untouched.
 */
export function snapshotVaultFileIds(dbFilePath: string, opts: { withLog?: boolean } = {}): string[] {
  let db: Database | null = null;
  let copyDir: string | null = null;
  try {
    if (opts.withLog) {
      copyDir = mkdtempSync(join(tmpdir(), "ppm-vault-ids-"));
      const copy = join(copyDir, "db.sqlite");
      copyFileSync(dbFilePath, copy);
      for (const side of ["-wal", "-shm"]) if (existsSync(`${dbFilePath}${side}`)) copyFileSync(`${dbFilePath}${side}`, `${copy}${side}`);
      db = new Database(copy);
    } else {
      db = new Database(dbFilePath, { readonly: true });
    }
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_attachments'").get();
    if (!table) return [];
    return (db.query("SELECT file_id FROM vault_attachments").all() as { file_id: string }[])
      .map((r) => r.file_id)
      .filter((id) => VAULT_FILE_ID.test(id));
  } finally {
    try { db?.close(); } catch { /* already closed */ }
    if (copyDir) rmSync(copyDir, { recursive: true, force: true });
  }
}

/** Puts `from` at `to`: a hard link where possible, a copy otherwise. */
function linkOrCopy(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return;
    copyFileSync(from, to);
  }
}

const ensureDir = (dir: string) => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }); };

/**
 * The databases a restore set aside beside `dbPath` (`ppm.db.replaced-<stamp>`): undoing a restore
 * means putting one back, so the files it names are kept like a snapshot's.
 */
export function archivedDatabases(dbPath: string): string[] {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.replaced-`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && !/-(?:wal|shm)$/.test(n))
    .map((n) => join(dir, n));
}

/**
 * After `namingDbPath` (a snapshot, or a database a restore set aside) was written: keeps every file
 * it names in the shared folder, by default the one beside it.
 */
export function collectVaultFiles(namingDbPath: string, dbPath: string, poolDir?: string, opts: { withLog?: boolean } = {}): VaultFilesResult {
  const ids = snapshotVaultFileIds(namingDbPath, opts);
  const result: VaultFilesResult = { kept: 0, missing: [] };
  if (!ids.length) return result;
  const live = vaultFilesDirFor(dbPath);
  const pool = poolDir ?? backupVaultFilesDir(dirname(namingDbPath), basename(dbPath));
  ensureDir(pool);
  for (const id of ids) {
    const name = vaultFileName(id);
    const target = join(pool, name);
    if (existsSync(target)) { result.kept++; continue; }
    // A file removed after the snapshot began waits in `retired/` until this has run.
    const source = [join(live, name), join(live, RETIRED_DIR_NAME, name)].find((p) => existsSync(p));
    if (!source) { result.missing.push(id); continue; }
    try {
      linkOrCopy(source, target);
      result.kept++;
    } catch {
      result.missing.push(id);
    }
  }
  return result;
}

/**
 * Removes files from the shared folder that no remaining snapshot of `dbFile` names, nor any
 * database in `alsoNaming` (the ones a restore set aside).
 */
export function pruneVaultFilePool(backupsDir: string, dbFile: string, alsoNaming: readonly string[] = []): number {
  const pool = backupVaultFilesDir(backupsDir, dbFile);
  if (!existsSync(pool)) return 0;
  const stem = basename(dbFile).replace(/\.db$/, "");
  const named = new Set<string>();
  for (const name of readdirSync(backupsDir)) {
    const parsed = parseBackupName(name);
    if (!parsed || parsed.dbStem !== stem) continue;
    try {
      for (const id of snapshotVaultFileIds(join(backupsDir, name))) named.add(id);
    } catch {
      // A snapshot that cannot be read cannot say what it needs: keep everything this round.
      return 0;
    }
  }
  for (const path of alsoNaming) {
    try {
      for (const id of snapshotVaultFileIds(path)) named.add(id);
    } catch {
      return 0;
    }
  }
  let removed = 0;
  for (const name of readdirSync(pool)) {
    const m = /^([0-9a-f]{32})\.bin$/.exec(name);
    if (!m || named.has(m[1]!)) continue;
    try { rmSync(join(pool, name), { force: true }); removed++; } catch { /* next time */ }
  }
  return removed;
}

/** After `snapshotPath` was restored over `dbPath`: puts back every file it names that is not there. */
export function restoreVaultFiles(snapshotPath: string, dbPath: string): VaultFilesResult {
  const ids = snapshotVaultFileIds(dbPath);
  const result: VaultFilesResult = { kept: 0, missing: [] };
  if (!ids.length) return result;
  const live = vaultFilesDirFor(dbPath);
  const pool = backupVaultFilesDir(dirname(snapshotPath), basename(dbPath));
  ensureDir(live);
  for (const id of ids) {
    const name = vaultFileName(id);
    const target = join(live, name);
    if (existsSync(target)) { result.kept++; continue; }
    const source = [join(pool, name), join(live, RETIRED_DIR_NAME, name)].find((p) => existsSync(p));
    if (!source) { result.missing.push(id); continue; }
    try {
      // A copy, not a link: the pool's copy must outlive whatever happens to the live one.
      copyFileSync(source, target);
      result.kept++;
    } catch {
      result.missing.push(id);
    }
  }
  return result;
}
