import { copyFileSync, existsSync, linkSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { formatBackupStamp } from "./db-backup-paths.ts";
import { verifyBackupFile } from "./db-backup-sync.ts";
import { readStatus } from "../supervisor-state.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("backup");

/**
 * Restore a verified snapshot over the live database.
 *
 * Four properties this must not get wrong:
 *
 * 1. **Verify before overwriting.** The snapshot is integrity-checked first,
 *    so a rotted backup can never destroy a database that still had a chance.
 * 2. **Never destroy the file being replaced.** The current database is kept
 *    under a new name, not deleted — even a corrupt file is forensic evidence, and during
 *    the incident that motivated this module the only reason the cause could be
 *    established was that the broken file had been preserved.
 * 3. **Delete the stale write-ahead log.** A `-wal`/`-shm` pair left beside a
 *    freshly restored database gets replayed onto it on the next open, which
 *    silently reintroduces the very corruption being recovered from. This is
 *    the single easiest way to turn a good restore into a second outage.
 * 4. **Never leave the directory without its database.** The snapshot is copied
 *    beside the live file and verified before anything is touched. The live file
 *    then gets a second name as the archive (a hard link, or a copy where links
 *    are unsupported) and the snapshot replaces it in a single rename, so a crash
 *    at any point still leaves a database at the live path; a failed swap changes
 *    nothing.
 */

export interface RestoreResult {
  restoredFrom: string;
  dbPath: string;
  archivedTo: string | null;
  bytes: number;
}

/** The filesystem calls a restore can fail in; tests replace them to make each step fail. */
export interface RestoreFs {
  copyFileSync(from: string, to: string): void;
  renameSync(from: string, to: string): void;
  linkSync(existing: string, newPath: string): void;
}

/** Sidecar files SQLite keeps beside a database; they must not survive a swap. */
function sidecars(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

/**
 * Give the live database a second name at `archivedTo`: a hard link, so nothing
 * is copied, or a copy where the filesystem has no links. A file already at
 * `archivedTo` is an earlier restore's archive and is never replaced.
 */
function keepAsArchive(fs: RestoreFs, dbPath: string, archivedTo: string): void {
  try {
    fs.linkSync(dbPath, archivedTo);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
  }
  try {
    fs.copyFileSync(dbPath, archivedTo);
  } catch (e) {
    rmSync(archivedTo, { force: true });
    throw e;
  }
}

/** Move the archive's sidecars back beside `dbPath`; returns the ones that could not be moved. */
function returnSidecars(fs: RestoreFs, archivedTo: string, dbPath: string): string[] {
  const stranded: string[] = [];
  for (const side of sidecars(archivedTo)) {
    if (!existsSync(side)) continue;
    try { fs.renameSync(side, side.replace(archivedTo, dbPath)); } catch { stranded.push(side); }
  }
  return stranded;
}

/**
 * PID of a live supervisor from `status.json`, or null. Restoring under a
 * running server would have it writing into a file that is being replaced.
 */
export function liveSupervisorPid(): number | null {
  try {
    const pid = readStatus().supervisorPid;
    if (typeof pid !== "number" || pid <= 0) return null;
    process.kill(pid, 0); // throws when the PID is gone
    return pid;
  } catch {
    return null;
  }
}

export function restoreDb(
  backupPath: string,
  opts: { dbPath: string; force?: boolean; now?: Date; fs?: Partial<RestoreFs> },
): RestoreResult {
  const { dbPath } = opts;
  if (!existsSync(backupPath)) throw new Error(`Backup not found: ${backupPath}`);

  const check = verifyBackupFile(backupPath);
  if (!check.ok) {
    throw new Error(`Refusing to restore: backup failed integrity_check (${check.detail})`);
  }

  if (!opts.force) {
    const pid = liveSupervisorPid();
    if (pid !== null) {
      throw new Error(
        `PPM is running (supervisor PID ${pid}). Run \`ppm stop\` first, or pass --force to restore anyway.`,
      );
    }
  }

  const stamp = formatBackupStamp(opts.now ?? new Date());
  const stagingPath = `${dbPath}.restoring-${stamp}`;
  const fs: RestoreFs = {
    copyFileSync: opts.fs?.copyFileSync ?? copyFileSync,
    renameSync: opts.fs?.renameSync ?? renameSync,
    linkSync: opts.fs?.linkSync ?? linkSync,
  };
  const clearStaging = () => {
    for (const path of [stagingPath, ...sidecars(stagingPath)]) rmSync(path, { force: true });
  };
  try {
    fs.copyFileSync(backupPath, stagingPath);
  } catch (e) {
    clearStaging();
    log.error(`copying ${backupPath} to ${stagingPath} failed: ${(e as Error).message}; current database untouched`);
    throw e;
  }

  const staged = verifyBackupFile(stagingPath);
  if (!staged.ok) {
    clearStaging();
    log.error(`staged ${stagingPath} failed integrity_check (${staged.detail}); current database untouched`);
    throw new Error(`Staged file failed integrity_check (${staged.detail}). Current database at ${dbPath} was not touched.`);
  }

  // The live file is archived under a second name instead of being moved, so
  // `dbPath` never stops existing: the rename below replaces it in one step.
  let archivedTo: string | null = null;
  if (existsSync(dbPath)) {
    archivedTo = `${dbPath}.replaced-${stamp}`;
    try {
      keepAsArchive(fs, dbPath, archivedTo);
    } catch (e) {
      clearStaging();
      log.error(`keeping ${dbPath} as ${archivedTo} failed: ${(e as Error).message}; current database untouched`);
      throw new Error(`Could not keep the current database as ${archivedTo} (${(e as Error).message}). Nothing was changed.`);
    }
    // Move the sidecars alongside the file they belong to, so the archived
    // database stays inspectable and cannot be replayed onto the new one.
    for (const side of sidecars(dbPath)) {
      if (existsSync(side)) {
        try { fs.renameSync(side, `${side.replace(dbPath, archivedTo)}`); } catch { rmSync(side, { force: true }); }
      }
    }
  }
  for (const side of sidecars(dbPath)) rmSync(side, { force: true });

  try {
    fs.renameSync(stagingPath, dbPath);
  } catch (e) {
    // `dbPath` still holds the previous database, so undoing the archive step is
    // putting its sidecars back and dropping the second name. A sidecar that will
    // not move keeps the archive, so the pair stays together.
    const stranded = archivedTo ? returnSidecars(fs, archivedTo, dbPath) : [];
    if (archivedTo && stranded.length === 0) rmSync(archivedTo, { force: true });
    clearStaging();
    const message = `Installing restored database at ${dbPath} failed (${(e as Error).message}). The current database was not changed`
      + (stranded.length ? `, but ${stranded.join(", ")} could not be moved back beside it.` : ".");
    log.error(message);
    throw new Error(message);
  }
  clearStaging();

  const bytes = statSync(dbPath).size;
  log.info(`restored ${backupPath} over ${dbPath} (previous archived to ${archivedTo ?? "(none)"}, ${bytes} B, force=${!!opts.force})`);
  return { restoredFrom: backupPath, dbPath, archivedTo, bytes };
}

/** Resolve a user-supplied backup argument: absolute/relative path, or a bare snapshot filename. */
export function resolveBackupArg(arg: string, backupsDir: string): string {
  if (existsSync(arg)) return resolve(arg);
  const inDir = resolve(backupsDir, arg);
  if (existsSync(inDir)) return inDir;
  throw new Error(`Backup not found: ${arg}`);
}
