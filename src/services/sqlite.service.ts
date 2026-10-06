import { Database, type Statement } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { isPpmDirPath } from "./fs-path-guard.service.ts";
import { assertNoAttachStatement } from "./fs-ops/sql-statement-guard.ts";
import { readRows } from "./fs-ops/sql-row-reader.ts";

import type { ColumnInfo, QueryResult, TableInfo } from "./sqlite-types.ts";
import type { ResultColumn } from "../shared/db-grid.ts";
import type { DbColumnRef, DbForeignKey, DbObjectList, DbObjectRef, DbTableStructure } from "../shared/db-structure.ts";
import { sqliteObjectSql } from "./database/object-sql-sqlite.ts";
import type {
  DbCatalogTable, DbQuerySession, DbRowSet, DbRunResult, DbStatement, DbStatementOutcome, DbWriteSession, StreamRowsOptions,
} from "../types/database.ts";
import { toJsonRow } from "./database/db-values.ts";
import { RowBatcher, type BatchLimits } from "./database/export-batch.ts";
import { ROWID_ALIASES, sqliteGetStructure, sqliteListColumns, sqliteListForeignKeys, sqliteListObjects, sqliteRowidAlias } from "./database/analyser-sqlite.ts";
import { ChangesetStatementError, checkAffected, type ChangesetStatement } from "./database/changeset.ts";
import { QueryStatementError, READONLY_IMPORT, READONLY_STRUCTURE, ReadonlyViolationError } from "./database/db-errors.ts";
import { isReadOnlyQuery } from "./database/readonly-check.ts";
import { sqlCode } from "../shared/split-sql-statements.ts";
import { doubleQuoteIdent } from "./database/dialect.ts";
import { sqliteAlterPlan } from "./database/ddl/sqlite-alter-plan.ts";
import { applySqlitePlan } from "./database/ddl/sqlite-apply.ts";
import type { DdlPlan } from "./database/ddl/ddl-types.ts";
import type { TableDiff } from "./database/ddl/table-diff.ts";
import type { TableModel } from "../shared/db-table-model.ts";

// Re-exported so existing importers keep using the service as one entry point.
export type { ColumnInfo, QueryResult, TableInfo };

/**
 * Column names of a prepared statement, in order and with repeats kept.
 *
 * bun:sqlite builds `columnNames` from an object's keys, so a repeated name
 * collapses into one entry *and moves*: `SELECT 1 AS a, 2 AS b, 3 AS a`
 * reports `["b", "a"]` over three values, which pairs every value with the
 * wrong name. When the count says names were lost, the statement is prepared
 * again as a subquery — never run — because SQLite then renames repeats to
 * `a:1`, `a:2` in place; stripping the suffix recovers the real names.
 */
export function statementColumnNames(db: Database, stmt: Statement, sql: string): string[] {
  const names = stmt.columnNames;
  const count = (stmt as unknown as { native?: { columnsCount?: number } }).native?.columnsCount ?? names.length;
  if (count <= names.length) return names;
  const real = new Set(names);
  try {
    const body = sql.trim().replace(/;+\s*$/, "");
    const wrapped = db.prepare(`SELECT * FROM (\n${body}\n)`);
    try {
      const renamed = wrapped.columnNames;
      if (renamed.length === count) {
        return renamed.map((name) => {
          if (real.has(name)) return name;
          const base = name.replace(/:\d+$/, "");
          return real.has(base) ? base : name;
        });
      }
    } finally {
      wrapped.finalize();
    }
  } catch { /* not a SELECT that can be wrapped; fall through */ }
  return Array.from({ length: count }, (_, i) => names[i] ?? `column${i + 1}`);
}

/**
 * 64-bit integers come back as `bigint` from this statement only, so a value
 * past 2^53 is not rounded on the way out. bun:sqlite has had
 * `Statement.safeIntegers()` for a long time; its typings do not declare it.
 */
function useSafeIntegers(stmt: Statement): void {
  (stmt as Statement & { safeIntegers(enabled: boolean): unknown }).safeIntegers(true);
}

/**
 * The rows of a statement that returns some, as arrays, stopping after `maxRows`. bun:sqlite has
 * no way to step through rows as arrays: `values()` reads them all, and `iterate()` yields
 * objects, in which two columns of one name collapse into one. So a query is capped in SQL, by
 * preparing it again inside `SELECT * FROM (…) LIMIT n` — which keeps every column and its order
 * and never runs the original — and one that cannot be wrapped (PRAGMA, EXPLAIN, `… RETURNING`)
 * is walked with `iterate()`, unless it has repeated names that would collapse.
 */
function cappedRows(
  db: Database, stmt: Statement, sql: string, maxRows: number,
): { columns: ResultColumn[]; rows: unknown[][]; truncated: boolean } {
  let wrapped: Statement | null = null;
  try {
    wrapped = db.prepare(`SELECT * FROM (\n${sql.trim().replace(/;+\s*$/, "")}\n) LIMIT ${maxRows + 1}`);
  } catch { /* not a query that can be wrapped */ }
  if (wrapped) {
    try {
      useSafeIntegers(wrapped);
      const rows = wrapped.values() as unknown[][];
      // Types from the statement that ran: asking the original would step it, i.e. run the query twice.
      const columns = describeStatement(db, stmt, sql, wrapped);
      return rows.length > maxRows ? { columns, rows: rows.slice(0, maxRows), truncated: true } : { columns, rows, truncated: false };
    } finally {
      wrapped.finalize();
    }
  }
  const names = stmt.columnNames;
  const count = (stmt as unknown as { native?: { columnsCount?: number } }).native?.columnsCount ?? names.length;
  let rows: unknown[][] = [];
  let truncated = false;
  if (count > names.length) rows = stmt.values() as unknown[][];
  else {
    for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
      if (rows.length === maxRows) { truncated = true; break; }
      rows.push(names.map((n) => row[n]));
    }
  }
  return { columns: describeStatement(db, stmt, sql), rows, truncated };
}

/** Names from `stmt`; types from `typesFrom`, the statement that actually ran when that is another one. */
function describeStatement(db: Database, stmt: Statement, sql: string, typesFrom: Statement = stmt): ResultColumn[] {
  const names = statementColumnNames(db, stmt, sql);
  let declared: (string | null)[] = [];
  let runtime: (string | null)[] = [];
  try { declared = typesFrom.declaredTypes; } catch { /* not available before a step on some builds */ }
  try { runtime = typesFrom.columnTypes; } catch { /* only known after the first row */ }
  return names.map((name, i) => ({ name, type: (declared[i] ?? runtime[i] ?? "").toString() }));
}

/** Work an export's read does between turns of the event loop. */
const EXPORT_SLICE_MS = 16;

/**
 * Statements whose `changes` is the rows they wrote, when they return no rows. `WITH` begins a write
 * here: one that reads returns rows.
 */
const WRITE_STATEMENT = /^\s*(insert|update|delete|replace|with)\b/i;

/**
 * A failed Query tab statement, carrying where SQLite says the error is: bun:sqlite gives the
 * token's offset in UTF-8 bytes (-1 when the error is not about one token), turned here into the
 * 1-based character the other engines report.
 */
function sqliteStatementError(e: unknown, statement: string): QueryStatementError {
  const offset = (e as { byteOffset?: unknown } | null)?.byteOffset;
  const where = typeof offset === "number" && offset >= 0
    ? { position: new TextDecoder().decode(new TextEncoder().encode(statement).subarray(0, offset)).length + 1 }
    : {};
  return new QueryStatementError((e as Error | null)?.message ?? String(e), where, e);
}

/** How long an import's handle waits for another writer to let go of the file. */
const WRITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Parameters one statement may bind with this SQLite library: 32,766 since SQLite 3.32, 999 in a
 * library older or built with less — the system one Bun uses on macOS may be either.
 */
function sqliteMaxParams(db: Database): number {
  try {
    db.prepare("SELECT ?32766").finalize();
    return 32_766;
  } catch {
    return 999;
  }
}

/** Auto-close idle databases after 5 minutes */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface CachedDb {
  db: Database;
  timer: ReturnType<typeof setTimeout>;
}

class SqliteService {
  private cache = new Map<string, CachedDb>();

  /**
   * @param readonly open every file read-only (a handle of its own, never the
   *   read-write one), so SQLite refuses writes whatever the SQL says.
   */
  constructor(private readonly readonly = false) {}

  /**
   * A read-only file still accepts `VACUUM INTO '<path>'`, which writes a new
   * file anywhere, so SQL on a readonly connection must also read as a read.
   */
  private assertReadable(sql: string): void {
    if (this.readonly && !isReadOnlyQuery(sql, "sqlite")) throw new ReadonlyViolationError();
  }

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
    const db = this.readonly
      ? new Database(absPath, { readonly: true })
      : new Database(absPath, { readwrite: true, create: false });
    if (!this.readonly) {
      // Neither pragma can be set on a read-only handle; it reads a WAL file
      // as it finds it, and enforces no foreign keys because it writes nothing.
      db.exec("PRAGMA journal_mode = WAL");
      // SQLite defaults FK enforcement off per connection, which would let the
      // viewer delete rows other clients reject and leave orphaned children.
      db.exec("PRAGMA foreign_keys = ON");
    }
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
    const cols = db.query(`PRAGMA table_info("${table}")`).all() as Omit<ColumnInfo, "fk" | "autoIncrement">[];

    // Build FK map from PRAGMA foreign_key_list
    const fkRows = db.query(`PRAGMA foreign_key_list("${table}")`).all() as { from: string; table: string; to: string }[];
    const fkMap = new Map<string, { table: string; column: string }>();
    for (const fk of fkRows) {
      fkMap.set(fk.from, { table: fk.table, column: fk.to });
    }

    const rowid = sqliteRowidAlias(db, table);
    return cols.map((c) => ({ ...c, fk: fkMap.get(c.name) ?? null, autoIncrement: c.name === rowid }));
  }

  /**
   * Get paginated rows from a table. The names and the direction come from a request's query
   * string: the names are quoted, and the direction is ASC unless it is exactly DESC.
   */
  getTableData(
    projectPath: string, dbPath: string, table: string,
    page = 1, limit = 100, orderBy?: string, orderDir: "ASC" | "DESC" = "ASC",
  ): { columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number } {
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.open(abs);

    const from = doubleQuoteIdent(table);
    const total = (db.query(`SELECT COUNT(*) as cnt FROM ${from}`).get() as { cnt: number }).cnt;
    const offset = (page - 1) * limit;
    const order = orderBy ? `ORDER BY ${doubleQuoteIdent(orderBy)} ${orderDir === "DESC" ? "DESC" : "ASC"}` : "";
    const rows = db.query(`SELECT rowid, * FROM ${from} ${order} LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[];

    // Get column names from first row or pragma
    const schema = db.query(`PRAGMA table_info(${from})`).all() as { name: string }[];
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
    this.assertReadable(sql);
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
    this.assertReadable(sql);
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

  /**
   * Columns of a table or view — generated columns included, a virtual table's
   * hidden columns left out — and what addresses one of its rows: the primary
   * key, or for a rowid table without one the first rowid alias no column
   * shadows. Null when the table does not exist.
   */
  describeTable(projectPath: string, dbPath: string, table: string): DbCatalogTable | null {
    const db = this.open(this.resolvePath(projectPath, dbPath));
    const info = db.query("SELECT type, wr FROM pragma_table_list WHERE schema = 'main' AND name = ? COLLATE NOCASE")
      .get(table) as { type: string; wr: number } | null;
    if (!info) return null;
    const rows = db.query("SELECT name, type, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid")
      .all(table) as { name: string; type: string; pk: number; hidden: number }[];
    const columns = rows.filter((r) => r.hidden !== 1);
    const pk = columns.filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name);
    const names = new Set(columns.map((c) => c.name.toLowerCase()));
    const rowidAliases = info.type !== "view" && info.wr !== 1 ? ROWID_ALIASES.filter((alias) => !names.has(alias)) : [];
    const rowid = pk.length === 0 ? rowidAliases[0] ?? null : null;
    return {
      columns: columns.map((r) => ({ name: r.name, type: r.type ?? "" })),
      rowKey: pk.length > 0 ? pk : rowid ? [rowid] : [],
      rowKeyIsRowid: rowid !== null,
      rowidAliases,
    };
  }

  listObjects(projectPath: string, dbPath: string): DbObjectList {
    return sqliteListObjects(this.open(this.resolvePath(projectPath, dbPath)));
  }

  listColumns(projectPath: string, dbPath: string): DbColumnRef[] {
    return sqliteListColumns(this.open(this.resolvePath(projectPath, dbPath)));
  }

  getStructure(projectPath: string, dbPath: string, table: string): DbTableStructure | null {
    return sqliteGetStructure(this.open(this.resolvePath(projectPath, dbPath)), table);
  }

  listForeignKeys(projectPath: string, dbPath: string): DbForeignKey[] {
    return sqliteListForeignKeys(this.open(this.resolvePath(projectPath, dbPath)));
  }

  getObjectSql(projectPath: string, dbPath: string, obj: DbObjectRef): string | null {
    return sqliteObjectSql(this.open(this.resolvePath(projectPath, dbPath)), obj);
  }

  /**
   * Run a changeset's statements in one transaction, in order, and return how
   * many rows each hit. The first failure, or an UPDATE/DELETE that does not
   * hit exactly one row, rolls every statement back.
   */
  applyChangeset(projectPath: string, dbPath: string, statements: ChangesetStatement[]): number[] {
    if (this.readonly) throw new ReadonlyViolationError("Connection is readonly — saving changes is disabled. Change this in PPM web UI.");
    const db = this.open(this.resolvePath(projectPath, dbPath));
    let ran = false;
    try {
      return db.transaction(() => {
        const counts = statements.map((s, i) => {
          let changes: number;
          let stmt: ReturnType<Database["prepare"]> | undefined;
          try {
            stmt = db.prepare(s.sql);
            changes = stmt.run(...(s.params as never[])).changes;
          } catch (e) {
            throw new ChangesetStatementError(i, s, e);
          } finally {
            stmt?.finalize();
          }
          checkAffected(statements, i, changes);
          return changes;
        });
        ran = true;
        return counts;
      })();
    } catch (e) {
      if (e instanceof ChangesetStatementError) throw e;
      // Every statement ran, so the COMMIT failed: a deferred foreign key.
      if (ran) throw new ChangesetStatementError(null, null, e);
      throw e;
    }
  }

  /** The table editor's DDL, written from the table's own schema text (see `sqliteAlterPlan`). */
  planAlterTable(projectPath: string, dbPath: string, base: TableModel, current: TableModel, diff: TableDiff): DdlPlan {
    return sqliteAlterPlan(this.open(this.resolvePath(projectPath, dbPath)), base, current, diff);
  }

  /** Run a DDL plan in one transaction (see `applySqlitePlan`). */
  applyDdl(projectPath: string, dbPath: string, plan: DdlPlan): void {
    if (this.readonly) throw new ReadonlyViolationError(READONLY_STRUCTURE);
    applySqlitePlan(this.open(this.resolvePath(projectPath, dbPath)), plan);
  }

  /**
   * Run one grid SELECT. bun:sqlite prepares only the first statement of a
   * string and silently drops the rest, so a second statement can never run
   * from here; integers keep full 64-bit precision.
   */
  selectRows(projectPath: string, dbPath: string, stmt: DbStatement): DbRowSet {
    const db = this.open(this.resolvePath(projectPath, dbPath));
    const query = db.prepare(stmt.sql);
    try {
      useSafeIntegers(query);
      const rows = query.values(...(stmt.params as never[]));
      return { columns: describeStatement(db, query, stmt.sql), rows: rows.map(toJsonRow) };
    } finally {
      query.finalize();
    }
  }

  /**
   * Export's read, on a read-only handle of its own, closed with the rows: a statement left open
   * on the shared handle would hold its transaction open under every write made through it. Each
   * step is a blocking call, so the read pauses for the event loop every `EXPORT_SLICE_MS` of work
   * — awaiting a fast download alone never gives other requests a turn.
   */
  async *streamRows(projectPath: string, dbPath: string, stmt: DbStatement, limits: BatchLimits, opts: StreamRowsOptions = {}): AsyncGenerator<unknown[][]> {
    const { onColumns, signal } = opts;
    signal?.throwIfAborted();
    const db = new Database(this.resolvePath(projectPath, dbPath), { readonly: true });
    try {
      const query = db.prepare(stmt.sql);
      let reading = query;
      try {
        useSafeIntegers(query);
        onColumns?.(describeStatement(db, query, stmt.sql));
        // `iterate()` yields objects, in which two columns of one name collapse into one — a query
        // joining two `id`s would lose a column and shift every value after it. SQLite names a
        // subquery's columns apart (`id`, `id:1`), so such a statement is read through one.
        const count = (query as unknown as { native?: { columnsCount?: number } }).native?.columnsCount ?? query.columnNames.length;
        if (count > query.columnNames.length) {
          try {
            reading = db.prepare(`SELECT * FROM (\n${stmt.sql.trim().replace(/;+\s*$/, "")}\n)`);
          } catch {
            throw new Error("Two columns of the result have one name: give them names of their own with AS");
          }
          useSafeIntegers(reading);
        }
        const names = reading.columnNames;
        const batcher = new RowBatcher(limits);
        let sliceStart = performance.now();
        for (const row of reading.iterate(...(stmt.params as never[])) as Iterable<Record<string, unknown>>) {
          const batch = batcher.add(names.map((n) => row[n]));
          if (batch) yield batch;
          // Every row, not every batch: a filter that matches rarely spends long between two batches.
          if (performance.now() - sliceStart >= EXPORT_SLICE_MS) {
            await new Promise((r) => setTimeout(r, 0));
            // A step cannot be interrupted from here; the turn between two is where a stop lands.
            signal?.throwIfAborted();
            sliceStart = performance.now();
          }
        }
        const last = batcher.take();
        if (last.length) yield last;
      } finally {
        if (reading !== query) reading.finalize();
        query.finalize();
      }
    } finally {
      db.close();
    }
  }

  /**
   * Import's writer (see `DbWriteSession`), on a read-write handle of its own whose
   * `BEGIN IMMEDIATE` takes the write lock at once: with another writer on the file the import
   * fails at its start rather than halfway. Foreign keys are enforced on it, as on the shared
   * handle. A statement cannot be interrupted from here; Stop lands between two of them.
   */
  openWriteSession(projectPath: string, dbPath: string): DbWriteSession {
    if (this.readonly) throw new ReadonlyViolationError(READONLY_IMPORT);
    const db = new Database(this.resolvePath(projectPath, dbPath), { readwrite: true, create: false });
    try {
      db.exec(`PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      db.close();
      throw e;
    }
    let ended = false;
    const open = (): Database => {
      if (ended) throw new Error("The import's database file is closed");
      return db;
    };
    const end = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    };
    return {
      maxParams: sqliteMaxParams(db),
      ddl: async (sql) => { open().exec(sql); },
      // `query` keeps the statement prepared: every full batch is the same text.
      run: async (stmt) => open().query(stmt.sql).run(...(stmt.params as never[])).changes,
      commit: async () => {
        open().exec("COMMIT");
        await end();
      },
      close: end,
      cancel: () => {},
    };
  }

  /**
   * The Query tab's session (see `DbQuerySession`) on a handle of its own, closed with the run: a
   * `PRAGMA`, a `TEMP` table or a `BEGIN` holds from one statement to the next and goes with it, and
   * a transaction the script leaves open never reaches the handle the grid shares. Each statement is
   * prepared alone, so text the splitter misread as one statement runs its first part only. SQLite
   * runs on this thread and a statement cannot be interrupted from here: Stop lands between two.
   * `maxQueryRows` keeps a file opened from the filesystem below the run's own row limit.
   */
  openQuerySession(projectPath: string, dbPath: string, maxQueryRows?: number): DbQuerySession {
    const abs = this.resolvePath(projectPath, dbPath);
    const db = this.readonly ? new Database(abs, { readonly: true }) : new Database(abs, { readwrite: true, create: false });
    if (!this.readonly) {
      try {
        db.exec("PRAGMA foreign_keys = ON");
      } catch (e) {
        db.close();
        throw e;
      }
    }
    const runStatement = (text: string, maxRows: number): DbStatementOutcome => {
      try {
        assertNoAttachStatement(text);
        this.assertReadable(text);
      } catch (e) {
        throw new QueryStatementError((e as Error).message, {}, e);
      }
      let stmt: Statement;
      try {
        stmt = db.prepare(text);
      } catch (e) {
        throw sqliteStatementError(e, text);
      }
      try {
        if (stmt.columnNames.length > 0) {
          useSafeIntegers(stmt);
          const { columns, rows, truncated } = cappedRows(db, stmt, text, Math.min(maxRows, maxQueryRows ?? maxRows));
          return { resultSets: [{ columns, rows: rows.map(toJsonRow), truncated }], notices: [] };
        }
        const { changes } = stmt.run();
        // `changes` is the last INSERT, UPDATE or DELETE's count, whatever ran since.
        const wrote = WRITE_STATEMENT.test(sqlCode(text, "sqlite"));
        return { resultSets: [], ...(wrote ? { rowsAffected: changes } : {}), notices: [] };
      } catch (e) {
        throw sqliteStatementError(e, text);
      } finally {
        stmt.finalize();
      }
    };
    let ended = false;
    return {
      splitOptions: {},
      run: async (text, maxRows) => runStatement(text, maxRows),
      cancel: () => {},
      rollbackOpenTransaction: async () => {
        if (!db.inTransaction) return false;
        db.exec("ROLLBACK");
        return true;
      },
      close: async () => {
        if (ended) return;
        ended = true;
        db.close();
      },
    };
  }

  /** COUNT(*) — SQLite has no way to interrupt a query from here, so there is no timeout. */
  countRows(projectPath: string, dbPath: string, stmt: DbStatement): number {
    const db = this.open(this.resolvePath(projectPath, dbPath));
    const row = db.query(stmt.sql).get(...(stmt.params as never[])) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  /**
   * Run SQL typed by the user. A statement that describes result columns
   * (SELECT, PRAGMA, `… RETURNING`) returns its rows — no more than `maxRows`
   * when it is given; anything else goes through `run()`, which executes every
   * statement in the text, as `executeQuery` always has.
   */
  runQuery(projectPath: string, dbPath: string, sql: string, maxRows?: number): DbRunResult {
    assertNoAttachStatement(sql);
    this.assertReadable(sql);
    const db = this.open(this.resolvePath(projectPath, dbPath));
    const start = performance.now();
    const stmt = db.prepare(sql);
    try {
      if (stmt.columnNames.length > 0) {
        useSafeIntegers(stmt);
        const { columns, rows, truncated } = maxRows === undefined
          ? { rows: stmt.values(), truncated: false, columns: null }
          : cappedRows(db, stmt, sql, maxRows);
        return {
          columns: columns ?? describeStatement(db, stmt, sql),
          rows: rows.map(toJsonRow),
          rowsAffected: 0,
          changeType: "select",
          executionTimeMs: Math.round(performance.now() - start),
          ...(truncated ? { truncated: true } : {}),
        };
      }
    } finally {
      stmt.finalize();
    }
    const result = db.run(sql);
    return { columns: [], rows: [], rowsAffected: result.changes, changeType: "modify", executionTimeMs: Math.round(performance.now() - start) };
  }

  /** Close all cached databases (for shutdown) */
  closeAll() {
    for (const absPath of this.cache.keys()) this.close(absPath);
  }
}

export const sqliteService = new SqliteService();
/** For connections marked readonly: files opened read-only, cached apart from the read-write handles. */
export const readonlySqliteService = new SqliteService(true);
