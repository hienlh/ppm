import { getTraceDb, getTraceDbSizeBytes } from "./session-trace-db.ts";

/** Ceiling on rows removed per pass, so the write lock is never held for long. */
const MAX_BATCH = 2_000;
/** Stops a pathological loop if vacuuming somehow never reduces the file. */
const MAX_PASSES = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many rows to drop to get back under the cap, sized from the actual excess so the log
 * stays as full as the cap allows (same reasoning as `query-audit-cleanup.ts`).
 */
function rowsToDrop(currentBytes: number, maxBytes: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  const avgRowBytes = Math.max(1, currentBytes / rowCount);
  const needed = Math.ceil((currentBytes - maxBytes) / avgRowBytes) + 1;
  return Math.max(1, Math.min(needed, MAX_BATCH, rowCount));
}

export interface TraceCleanupResult {
  deletedByAge: number;
  deletedBySize: number;
  freedBytes: number;
}

/**
 * Prune the trace by age, then by size, oldest first — mirrors `cleanupQueryAudit`.
 *
 * Deleting alone never shrinks a SQLite file; `incremental_vacuum` returns the pages, and only
 * because the database was created with `auto_vacuum = INCREMENTAL`. Size comes from page
 * counts so an active WAL does not distort it.
 */
export function cleanupSessionTrace(retentionDays: number, maxSizeMb: number, now = Date.now()): TraceCleanupResult {
  const db = getTraceDb();
  const sizeBefore = getTraceDbSizeBytes();
  const cutoff = now - Math.max(1, Math.floor(retentionDays)) * DAY_MS;

  const deletedByAge = db.run("DELETE FROM session_events WHERE ts < ?", [cutoff]).changes;
  db.exec("PRAGMA incremental_vacuum");

  const maxBytes = Math.max(1, maxSizeMb) * 1024 * 1024;
  let deletedBySize = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const currentBytes = getTraceDbSizeBytes();
    if (currentBytes <= maxBytes) break;
    const rowCount = (db.query("SELECT COUNT(*) AS count FROM session_events").get() as { count: number }).count;
    const batch = rowsToDrop(currentBytes, maxBytes, rowCount);
    // Nothing left to drop — what remains is schema overhead, not rows.
    if (batch === 0) break;
    const removed = db.run(
      `DELETE FROM session_events WHERE rowid IN (
         SELECT rowid FROM session_events ORDER BY ts ASC LIMIT ${batch}
       )`,
    ).changes;
    if (removed === 0) break;
    deletedBySize += removed;
    db.exec("PRAGMA incremental_vacuum");
  }

  // An alias outlives nothing it points at: a conversation still being written keeps its alias
  // however old, one whose rows are all gone loses it.
  db.run("DELETE FROM trace_aliases WHERE NOT EXISTS (SELECT 1 FROM session_events e WHERE e.trace_id = trace_aliases.trace_id)");

  return { deletedByAge, deletedBySize, freedBytes: Math.max(0, sizeBefore - getTraceDbSizeBytes()) };
}
