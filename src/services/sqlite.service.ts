import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export interface TableInfo {
  name: string;
  rowCount: number;
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt_value: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  changeType: "select" | "modify";
}

/** Auto-close idle databases after 5 minutes */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface CachedDb {
  db: Database;
  timer: ReturnType<typeof setTimeout>;
}

class SqliteService {
  private cache = new Map<string, CachedDb>();

  /** Resolve db path — supports both project-relative and absolute paths */
  private resolvePath(projectPath: string, dbRelPath: string): string {
    const isAbsolute = /^(\/|[A-Za-z]:[/\\])/.test(dbRelPath);
    const abs = isAbsolute ? dbRelPath : resolve(projectPath, dbRelPath);
    if (!isAbsolute && !abs.startsWith(projectPath)) throw new Error("Access denied: path outside project");
    if (!existsSync(abs)) throw new Error(`Database not found: ${dbRelPath}`);
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
    const db = new Database(absPath);
    db.exec("PRAGMA journal_mode = WAL");
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

  /** Get column schema for a table */
  getTableSchema(projectPath: string, dbPath: string, table: string): ColumnInfo[] {
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);
    return db.query(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
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

  /** Execute arbitrary SQL */
  executeQuery(projectPath: string, dbPath: string, sql: string): QueryResult {
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);
    const trimmed = sql.trim().toUpperCase();
    const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN");

    if (isSelect) {
      const stmt = db.query(sql);
      const rows = stmt.all() as Record<string, unknown>[];
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      return { columns, rows, rowsAffected: 0, changeType: "select" };
    }

    const result = db.run(sql);
    return { columns: [], rows: [], rowsAffected: result.changes, changeType: "modify" };
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

  /** Close all cached databases (for shutdown) */
  closeAll() {
    for (const absPath of this.cache.keys()) this.close(absPath);
  }
}

export const sqliteService = new SqliteService();
