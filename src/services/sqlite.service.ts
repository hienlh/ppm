import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { isPpmDirPath } from "./fs-path-guard.service.ts";
import { assertNoAttachStatement } from "./fs-ops/sql-statement-guard.ts";
import { readRows } from "./fs-ops/sql-row-reader.ts";

import type { ColumnInfo, QueryResult, TableInfo } from "./sqlite-types.ts";

// Re-exported so existing importers keep using the service as one entry point.
export type { ColumnInfo, QueryResult, TableInfo };

/** Auto-close idle databases after 5 minutes */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface CachedDb {
  db: Database;
  timer: ReturnType<typeof setTimeout>;
}

class SqliteService {
  private cache = new Map<string, CachedDb>();

  /**
   * Resolve db path — supports both project-relative and absolute paths.
   *
   * Absolute paths are not probed with `existsSync`: they come from the
   * filesystem door, which can point at a dead network mount and would block
   * the event loop here. That door stats the file asynchronously before
   * calling in, and `open()` refuses to create a missing database, so nothing
   * is silently brought into existence either way.
   */
  private resolvePath(projectPath: string, dbRelPath: string): string {
    const isAbsolute = /^(\/|[A-Za-z]:[/\\])/.test(dbRelPath);
    const abs = isAbsolute ? dbRelPath : resolve(projectPath, dbRelPath);
    if (!isAbsolute && !abs.startsWith(projectPath)) throw new Error("Access denied: path outside project");
    // The PPM directory holds the config database with provider credentials and
    // the auth token. Absolute paths are accepted here, so this door has to
    // refuse it explicitly or a viewer could read the whole secret store.
    if (isPpmDirPath(resolve(abs))) throw new Error("Access denied: PPM directory is not browsable");
    if (!isAbsolute && !existsSync(abs)) throw new Error(`Database not found: ${dbRelPath}`);
    return abs;
  }

  /** Open (or reuse cached) database */
  private open(absPath: string): Database {
    const cached = this.cache.get(absPath);
    if (cached) {
      clearTimeout(cached.timer);
      cached.timer = setTimeout(() => this.close(absPath), IDLE_TIMEOUT_MS);
      return cached.db;
    }
    // `create: false` — a viewer must never bring a database file into
    // existence, least of all at a path the caller chose. `readwrite` has to
    // be spelled out alongside it: the two flags are passed straight to
    // sqlite3_open_v2, which rejects the combination that omits it.
    const db = new Database(absPath, { readwrite: true, create: false });
    db.exec("PRAGMA journal_mode = WAL");
    // SQLite defaults FK enforcement off per connection, which would let the
    // viewer delete rows other clients reject and leave orphaned children.
    db.exec("PRAGMA foreign_keys = ON");
    const timer = setTimeout(() => this.close(absPath), IDLE_TIMEOUT_MS);
    this.cache.set(absPath, { db, timer });
    return db;
  }

  /** Close and remove from cache */
  private close(absPath: string) {
    const cached = this.cache.get(absPath);
    if (!cached) return;
    clearTimeout(cached.timer);
    try { cached.db.close(); } catch { /* already closed */ }
    this.cache.delete(absPath);
  }

  /** List all user tables with row counts */
  getTables(projectPath: string, dbPath: string): TableInfo[] {
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);
    const tables = db.query(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];

    return tables.map((t) => {
      const row = db.query(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get() as { cnt: number };
      return { name: t.name, rowCount: row.cnt };
    });
  }

  /** Get column schema for a table (with FK metadata) */
  getTableSchema(projectPath: string, dbPath: string, table: string): ColumnInfo[] {
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);
    const cols = db.query(`PRAGMA table_info("${table}")`).all() as Omit<ColumnInfo, "fk">[];

    // Build FK map from PRAGMA foreign_key_list
    const fkRows = db.query(`PRAGMA foreign_key_list("${table}")`).all() as { from: string; table: string; to: string }[];
    const fkMap = new Map<string, { table: string; column: string }>();
    for (const fk of fkRows) {
      fkMap.set(fk.from, { table: fk.table, column: fk.to });
    }

    return cols.map((c) => ({ ...c, fk: fkMap.get(c.name) ?? null }));
  }

  /** Get paginated rows from a table */
  getTableData(
    projectPath: string, dbPath: string, table: string,
    page = 1, limit = 100, orderBy?: string, orderDir: "ASC" | "DESC" = "ASC",
  ): { columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number } {
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);

    const total = (db.query(`SELECT COUNT(*) as cnt FROM "${table}"`).get() as { cnt: number }).cnt;
    const offset = (page - 1) * limit;
    const order = orderBy ? `ORDER BY "${orderBy}" ${orderDir}` : "";
    const rows = db.query(`SELECT rowid, * FROM "${table}" ${order} LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[];

    // Get column names from first row or pragma
    const schema = db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    const columns = ["rowid", ...schema.map((c) => c.name)];

    return { columns, rows, total, page, limit };
  }

  /**
   * Execute arbitrary SQL. `maxRows` caps a SELECT result — a foreign database
   * opened through the filesystem door can be arbitrarily large, and reading
   * every row into memory to answer one request is a denial of service.
   */
  executeQuery(projectPath: string, dbPath: string, sql: string, maxRows?: number): QueryResult {
    assertNoAttachStatement(sql);
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);
    const trimmed = sql.trim().toUpperCase();
    const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") ||
      trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN");

    const start = performance.now();
    if (isSelect) {
      const { rows, truncated } = readRows(db.query(sql), maxRows);
      const executionTimeMs = Math.round(performance.now() - start);
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      return {
        columns, rows, rowsAffected: 0, changeType: "select", executionTimeMs,
        ...(truncated ? { truncated: true } : {}),
      };
    }

    const result = db.run(sql);
    const executionTimeMs = Math.round(performance.now() - start);
    return { columns: [], rows: [], rowsAffected: result.changes, changeType: "modify", executionTimeMs };
  }

  /** Execute multi-statement SQL script (no result rows returned) */
  executeScript(projectPath: string, dbPath: string, sql: string): { executionTimeMs: number } {
    assertNoAttachStatement(sql);
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);
    const start = performance.now();
    db.exec(sql);
    return { executionTimeMs: Math.round(performance.now() - start) };
  }

  /** Update a single cell value */
  updateCell(
    projectPath: string, dbPath: string, table: string,
    rowid: number, column: string, value: unknown,
    pkColumn = "rowid",
  ): void {
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);
    db.run(`UPDATE "${table}" SET "${column}" = ? WHERE "${pkColumn}" = ?`, [value as never, rowid]);
  }

  /** Delete a row by primary key */
  deleteRow(
    projectPath: string, dbPath: string, table: string,
    pkValue: unknown, pkColumn = "rowid",
  ): void {
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);
    db.run(`DELETE FROM "${table}" WHERE "${pkColumn}" = ?`, [pkValue as never]);
  }

  /** Close all cached databases (for shutdown) */
  closeAll() {
    for (const absPath of this.cache.keys()) this.close(absPath);
  }
}

export const sqliteService = new SqliteService();
