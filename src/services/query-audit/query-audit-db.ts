import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";

const SCHEMA_VERSION = 1;

let cached: Database | undefined;

export function getAuditDbPath(): string {
  return join(getPpmDir(), "query-audit.db");
}

/** Open (or reuse) the audit database. Separate file from ppm.db so audit volume never bloats config/session data. */
export function getAuditDb(): Database {
  if (cached) return cached;

  const dir = getPpmDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(getAuditDbPath());
  // Only takes effect when set before the first table exists. Without it DELETE never
  // returns disk space, which would make the size cap in the cleanup job meaningless.
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  // Server and CLI write to this file from separate processes; without a wait
  // a concurrent write would surface as SQLITE_BUSY and drop the audit entry.
  db.exec("PRAGMA busy_timeout = 2000");
  migrate(db);

  cached = db;
  return db;
}

function migrate(db: Database): void {
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };

  if (user_version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER,
        connection_name TEXT,
        db_type TEXT,
        source TEXT NOT NULL,
        actor TEXT NOT NULL,
        operation TEXT NOT NULL,
        sql TEXT NOT NULL,
        params_json TEXT,
        status TEXT NOT NULL,
        error TEXT,
        row_count INTEGER,
        duration_ms INTEGER,
        bytes INTEGER,
        result_head TEXT,
        result_tail TEXT,
        result_truncated INTEGER DEFAULT 0,
        caller_ip TEXT,
        caller_ua TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_query_log_created ON query_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_query_log_conn ON query_log(connection_id, created_at);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }
}

/** Current size on disk, derived from pages so it stays accurate while WAL is active. */
export function getAuditDbSizeBytes(): number {
  const db = getAuditDb();
  const { page_count } = db.query("PRAGMA page_count").get() as { page_count: number };
  const { page_size } = db.query("PRAGMA page_size").get() as { page_size: number };
  return page_count * page_size;
}

export function closeAuditDb(): void {
  cached?.close();
  cached = undefined;
}
