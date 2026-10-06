import { copyFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { formatBackupStamp } from "./db-backup-paths.ts";
import { verifyBackupFile } from "./db-backup-sync.ts";
import { readStatus } from "../supervisor-state.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("backup");

/**
 * Restore a verified snapshot over the live database.
 *
 * Three properties this must not get wrong:
 *
 * 1. **Verify before overwriting.** The snapshot is integrity-checked first,
 *    so a rotted backup can never destroy a database that still had a chance.
 * 2. **Never destroy the file being replaced.** The current database is moved
 *    aside, not deleted — even a corrupt file is forensic evidence, and during
 *    the incident that motivated this module the only reason the cause could be
 *    established was that the broken file had been preserved.
 * 3. **Delete the stale write-ahead log.** A `-wal`/`-shm` pair left beside a
 *    freshly restored database gets replayed onto it on the next open, which
 *    silently reintroduces the very corruption being recovered from. This is
 *    the single easiest way to turn a good restore into a second outage.
 */

export interface RestoreResult {
  restoredFrom: string;
  dbPath: string;
  archivedTo: string | null;
  bytes: number;
}

/** Sidecar files SQLite keeps beside a database; they must not survive a swap. */
function sidecars(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
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
  opts: { dbPath: string; force?: boolean; now?: Date },
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
  let archivedTo: string | null = null;
  if (existsSync(dbPath)) {
    archivedTo = `${dbPath}.replaced-${stamp}`;
    renameSync(dbPath, archivedTo);
    // Move the sidecars alongside the file they belong to, so the archived
    // database stays inspectable and cannot be replayed onto the new one.
    for (const side of sidecars(dbPath)) {
      if (existsSync(side)) {
        try { renameSync(side, `${side.replace(dbPath, archivedTo)}`); } catch { rmSync(side, { force: true }); }
      }
    }
  }
  for (const side of sidecars(dbPath)) rmSync(side, { force: true });

  try {
    copyFileSync(backupPath, dbPath);
  } catch (e) {
    // The live database is already moved aside, and the thrown message does not say where.
    log.error(`copying ${backupPath} over ${dbPath} failed: ${(e as Error).message}; previous database kept at ${archivedTo ?? "(none)"}`);
    throw e;
  }

  const after = verifyBackupFile(dbPath);
  if (!after.ok) {
    log.error(`restored ${dbPath} failed integrity_check (${after.detail}); previous database kept at ${archivedTo ?? "(none)"}`);
    throw new Error(
      `Restored file failed integrity_check (${after.detail}). Previous database preserved at ${archivedTo ?? "(none)"}.`,
    );
  }

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
