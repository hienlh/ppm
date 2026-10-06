import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";

const SCHEMA_VERSION = 2;

let cached: Database | undefined;

export function getTraceDbPath(): string {
  return join(getPpmDir(), "session-trace.db");
}

/**
 * Open (or reuse) the trace database.
 *
 * A file of its own for the reason `query-audit.db` is one: event volume must not bloat config
 * and workspace state in `ppm.db`. Deliberately outside `db-backup` — this is a log, not state.
 */
export function getTraceDb(): Database {
  if (cached) return cached;

  const dir = getPpmDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(getTraceDbPath());
  // Server and CLI append from separate processes; without a wait a concurrent write
  // surfaces as SQLITE_BUSY and the batch is dropped. First, because the pragmas below take
  // locks too: set after them, a lock another process held for 300 ms failed this open.
  db.exec("PRAGMA busy_timeout = 2000");
  // Only takes effect when set before the first table exists. Without it DELETE never
  // returns disk space, which would make the size cap in the cleanup job meaningless.
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  // A log: losing the last few milliseconds on power loss is the right trade for not
  // paying an fsync per commit. Per connection, so it is set on every open.
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);

  cached = db;
  return db;
}

function migrate(db: Database): void {
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };

  if (user_version < 1) {
    // `trace_id` is the id a run started under and never the one a provider swaps in
    // mid-stream (`session_migrated`); `trace_aliases` maps those later ids back, so one
    // conversation stays one trace. `seq` is ours, assigned at insert — timestamps order
    // nothing across two processes.
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        trace_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        turn_id TEXT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        origin TEXT NOT NULL,
        provider_id TEXT,
        ref_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (trace_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_ref ON session_events(ref_id, ts) WHERE ref_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_session_events_ts ON session_events(ts);
      CREATE TABLE IF NOT EXISTS trace_aliases (
        alias_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }

  if (user_version < 2) {
    // Which browser a device id is. A batch carries only the id; the request's User-Agent is
    // what names it in Logs ("Chrome·Mac") and in a bug report's Environment.
    db.exec(`
      CREATE TABLE IF NOT EXISTS trace_devices (
        device_id TEXT PRIMARY KEY,
        user_agent TEXT NOT NULL,
        last_seen INTEGER NOT NULL
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }
}

/** Current size on disk, derived from pages so it stays accurate while WAL is active. */
export function getTraceDbSizeBytes(): number {
  const db = getTraceDb();
  const { page_count } = db.query("PRAGMA page_count").get() as { page_count: number };
  const { page_size } = db.query("PRAGMA page_size").get() as { page_size: number };
  return page_count * page_size;
}

export function closeTraceDb(): void {
  cached?.close();
  cached = undefined;
}
