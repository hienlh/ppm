import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_CONFIG } from "../types/config.ts";
import type { StorageAppDb, StorageBackups, StorageOverview, StorageSessionTrace } from "../shared/storage-settings.ts";
import { configService } from "./config.service.ts";
import { fileSizeWithWal, getDbPath } from "./db.service.ts";
import { getBackupsDir, parseBackupName } from "./db-backup/db-backup-paths.ts";
import { listBackups } from "./db-backup/db-backup.service.ts";
import { getTraceDb, getTraceDbPath, getTraceDbSizeBytes } from "./session-trace/session-trace-db.ts";

/**
 * What Settings → Storage shows: how much disk PPM's own databases and their snapshots take.
 * Read-only, and a file or folder that does not exist yet reads as empty rather than failing —
 * in particular the session trace is never created just to be measured.
 */

export function appDbStorage(): StorageAppDb {
  const path = getDbPath();
  return { path, sizeBytes: fileSizeWithWal(path) };
}

/**
 * This server's own snapshots, and apart from them every other database's in the same folder:
 * prod and dev share `~/.ppm-backups`, and a dev snapshot must not read as prod's newest.
 */
export function backupsStorage(): StorageBackups {
  const dir = getBackupsDir();
  const dbStem = basename(getDbPath()).replace(/\.db$/, "");
  let count = 0;
  let totalBytes = 0;
  let newest: StorageBackups["newest"] = null;
  const others = new Map<string, { dbStem: string; count: number; totalBytes: number }>();
  for (const entry of listBackups()) {
    const stem = parseBackupName(entry.name)?.dbStem;
    if (stem !== dbStem) {
      const key = stem ?? "?";
      const other = others.get(key) ?? { dbStem: key, count: 0, totalBytes: 0 };
      other.count++;
      other.totalBytes += entry.bytes;
      others.set(key, other);
      continue;
    }
    count++;
    totalBytes += entry.bytes;
    let mtimeMs: number;
    try { mtimeMs = statSync(entry.path).mtimeMs; } catch { continue; }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { name: entry.name, mtimeMs };
  }
  return { dir, dbStem, count, totalBytes, newest, others: [...others.values()].sort((a, b) => b.totalBytes - a.totalBytes) };
}

export function sessionTraceStorage(): StorageSessionTrace {
  const path = getTraceDbPath();
  const limits = configService.get("session_trace") ?? DEFAULT_CONFIG.session_trace;
  const base = { path, retention_days: limits.retention_days, max_size_mb: limits.max_size_mb };
  if (!existsSync(path)) return { ...base, sizeBytes: 0, oldestTs: null };
  const row = getTraceDb().query("SELECT MIN(ts) AS oldest FROM session_events").get() as { oldest: number | null } | null;
  return { ...base, sizeBytes: getTraceDbSizeBytes(), oldestTs: row?.oldest ?? null };
}

export function storageOverview(): StorageOverview {
  return { appDb: appDbStorage(), backups: backupsStorage(), sessionTrace: sessionTraceStorage() };
}
