import { getAuditDb, getAuditDbSizeBytes } from "./query-audit-db.ts";

/** Ceiling on rows removed per pass, so the write lock is never held for long. */
const MAX_BATCH = 500;
/** Stops a pathological loop if vacuuming somehow never reduces the file. */
const MAX_PASSES = 40;

/**
 * How many rows to drop to get back under the cap.
 *
 * A fixed batch size overshoots badly: 500 entries holding 16KB samples each is
 * 8MB, which would wipe an entire log that only needed to shed a few hundred KB.
 * Sizing the batch from the actual excess keeps the log as full as the cap allows.
 */
function rowsToDrop(currentBytes: number, maxBytes: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  const avgRowBytes = Math.max(1, currentBytes / rowCount);
  const excess = currentBytes - maxBytes;
  // One extra row covers rounding; pages free in chunks, so slight over-deletion is expected.
  const needed = Math.ceil(excess / avgRowBytes) + 1;
  return Math.max(1, Math.min(needed, MAX_BATCH, rowCount));
}

export interface CleanupResult {
  deletedByAge: number;
  deletedBySize: number;
  freedBytes: number;
}

/**
 * Prune the audit log by age, then by size.
 *
 * Deleting alone never shrinks a SQLite file; the space is only returned by
 * `incremental_vacuum`, and only because the database was created with
 * `auto_vacuum = INCREMENTAL`. Size is measured from page counts rather than
 * the file on disk so an active WAL does not distort the reading.
 */
export function cleanupQueryAudit(retentionDays: number, maxSizeMb: number): CleanupResult {
  const db = getAuditDb();
  const sizeBefore = getAuditDbSizeBytes();

  const byAge = db.run(
    "DELETE FROM query_log WHERE created_at < datetime('now', ?)",
    [`-${Math.max(1, Math.floor(retentionDays))} days`],
  ).changes;

  db.exec("PRAGMA incremental_vacuum");

  const maxBytes = Math.max(1, maxSizeMb) * 1024 * 1024;
  let deletedBySize = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const currentBytes = getAuditDbSizeBytes();
    if (currentBytes <= maxBytes) break;

    const rowCount = (db.query("SELECT COUNT(*) as count FROM query_log").get() as { count: number }).count;
    const batch = rowsToDrop(currentBytes, maxBytes, rowCount);
    // Nothing left to drop — what remains is schema overhead, not entries.
    if (batch === 0) break;

    const removed = db.run(
      `DELETE FROM query_log WHERE id IN (
         SELECT id FROM query_log ORDER BY created_at ASC, id ASC LIMIT ${batch}
       )`,
    ).changes;
    if (removed === 0) break;

    deletedBySize += removed;
    db.exec("PRAGMA incremental_vacuum");
  }

  return {
    deletedByAge: byAge,
    deletedBySize,
    freedBytes: Math.max(0, sizeBefore - getAuditDbSizeBytes()),
  };
}

/** Wipe every entry and return the space immediately. */
export function clearQueryAudit(): number {
  const db = getAuditDb();
  const removed = db.run("DELETE FROM query_log").changes;
  db.exec("PRAGMA incremental_vacuum");
  return removed;
}
