/**
 * Shapes behind Settings → Storage: how much disk PPM's own databases and backups take,
 * and the session trace's retention limits. Server: `src/server/routes/settings.ts`.
 */

/** The app database `ppm.db`. `sizeBytes` includes its `-wal` file, which holds unflushed pages. */
export interface StorageAppDb {
  path: string;
  sizeBytes: number;
}

/**
 * The snapshot folder (`~/.ppm-backups`). Read-only in the UI: retention is not editable there.
 * The folder is shared by every database PPM runs on this machine (`ppm.db`, `ppm.dev.db`), so the
 * figures are this server's own database, and every other database's snapshots are listed apart.
 */
export interface StorageBackups {
  dir: string;
  /** Stem of the database this server runs on, e.g. `ppm` or `ppm.dev`. */
  dbStem: string;
  count: number;
  totalBytes: number;
  /** Most recent snapshot of this database by modification time, or null when there is none. */
  newest: { name: string; mtimeMs: number } | null;
  /** Snapshots of other databases in the same folder, largest first. */
  others: { dbStem: string; count: number; totalBytes: number }[];
}

/** `session-trace.db` and the limits its daily cleanup applies. */
export interface StorageSessionTrace {
  path: string;
  sizeBytes: number;
  /** Timestamp (ms) of the oldest recorded event, or null when the trace is empty or missing. */
  oldestTs: number | null;
  retention_days: number;
  max_size_mb: number;
}

/** GET /api/settings/storage */
export interface StorageOverview {
  appDb: StorageAppDb;
  backups: StorageBackups;
  sessionTrace: StorageSessionTrace;
}

/** PUT /api/settings/session-trace answers with the refreshed `StorageSessionTrace`. */
export interface SessionTraceLimitsInput {
  retention_days?: number;
  max_size_mb?: number;
}

/** Below these the trace would empty itself on the next busy turn. Shared so the form and the route agree. */
export const SESSION_TRACE_MIN_RETENTION_DAYS = 1;
export const SESSION_TRACE_MIN_SIZE_MB = 50;
