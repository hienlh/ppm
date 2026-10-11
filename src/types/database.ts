import type { QueryRunResponse, ResultColumn } from "../shared/db-grid.ts";
import type { DbColumnRef, DbForeignKey, DbObjectList, DbObjectRef, DbTableStructure } from "../shared/db-structure.ts";
import type { TableModel } from "../shared/db-table-model.ts";
import type { DbType } from "../shared/db-types.ts";
import type { DdlPlan } from "../services/database/ddl/ddl-types.ts";
import type { TableDiff } from "../services/database/ddl/table-diff.ts";
import type { BatchLimits } from "../services/database/export-batch.ts";
import type { SqlLexOptions } from "../shared/split-sql-statements.ts";

export type { DbType };

export interface DbConnectionConfig {
  type: DbType;
  path?: string;             // sqlite
  connectionString?: string; // postgres
  /**
   * The connection is marked readonly. Not part of the stored config: the
   * routes set it from the connection row, and adapters then use pools and
   * file handles on which the database itself refuses writes.
   */
  readonly?: boolean;
  /**
   * The most rows SQL typed by the user may return (SQLite only). Set for a database file opened
   * from the filesystem rather than saved as a connection: it can be any size, and is not the
   * user's own project data.
   */
  maxQueryRows?: number;
  [key: string]: unknown;
}

export interface DbTableInfo {
  name: string;
  schema: string; // "main" for sqlite, actual schema for postgres
  rowCount: number;
}

export interface DbColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue: string | null;
  /** Filled in by the database when a row is inserted without it: serial, identity, AUTO_INCREMENT, SQLite's INTEGER PRIMARY KEY. */
  autoIncrement: boolean;
  fk: { table: string; column: string } | null;
}

export interface DbQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  changeType: "select" | "modify";
  executionTimeMs: number;
}

export interface DbPagedData {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  limit: number;
}

/** A table or view column as the catalog declares it. */
export interface DbCatalogColumn {
  name: string;
  type: string;
}

/** A table or view as the grid needs it. */
export interface DbCatalogTable {
  /** In catalog order. */
  columns: DbCatalogColumn[];
  /**
   * What addresses one row: the primary key in key order, or SQLite's rowid
   * for a table without one. Empty when rows cannot be addressed.
   */
  rowKey: string[];
  /** `rowKey` is SQLite's rowid, which is not one of `columns` and is selected on its own. */
  rowKeyIsRowid: boolean;
  /**
   * Names that reach SQLite's rowid here — the aliases no column shadows — or
   * empty for Postgres, views and WITHOUT ROWID tables. A row key may use one
   * even when the table has a primary key: the older SQLite viewer addresses
   * every row by `rowid`.
   */
  rowidAliases: string[];
}

/** What a read streamed for Import/Export also takes. */
export interface StreamRowsOptions {
  /**
   * Hears the result's columns, as the driver describes them, before the first batch — and for a
   * statement that finds no rows, before the iteration ends.
   */
  onColumns?: (columns: ResultColumn[]) => void;
  /** Cancels the statement on the server: the read then fails with the database's own error. */
  signal?: AbortSignal;
}

/**
 * What `runQuery` also takes: a time limit and a signal, each of which stops the statement on
 * the server. Postgres cancels the backend's statement (and, on a read-only run, also sets
 * `statement_timeout` for it); MySQL and MariaDB `KILL QUERY` it from a second session (and set
 * `max_execution_time` / `max_statement_time` for the session first). SQLite runs a statement
 * synchronously on the server's own thread, where neither a timer nor an abort can be heard
 * until it ends, so there only a signal already aborted is honoured, before anything starts.
 * A stopped run throws `QueryStoppedError`.
 */
export interface RunQueryOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One parameterised statement, ready for the driver. */
export interface DbStatement {
  sql: string;
  params: unknown[];
}

/** One statement of a changeset, as the adapter runs it. */
export interface ChangesetStatement extends DbStatement {
  /** The same statement with values written out — shown to people, never executed. */
  displaySql: string;
  kind: "cascade" | "insert" | "update" | "delete";
  /** Anything but exactly one affected row fails the whole changeset. */
  expectOne: boolean;
}

/** Rows as arrays in column order, so two columns with one name both survive. */
export interface DbRowSet {
  columns: ResultColumn[];
  rows: unknown[][];
}

/** Result of SQL the user typed, described by the driver rather than guessed from rows. */
export type DbRunResult = QueryRunResponse;

/** What a connection test learns about the server. */
export interface DbProbe {
  /** `PostgreSQL 17.2`, `MariaDB 11.8.9`, `SQLite 3.46.1`. */
  version: string;
  /** Every database the login can open, the server's own left out; empty for SQLite. */
  databases: string[];
  /**
   * What the server says about the test's own connection: the TLS version when encrypted, null in
   * plain text. Absent for SQLite, and for a server that would not say.
   */
  tls?: string | null;
}

/** What one statement of a Query tab run did, as the engine answered it. */
export interface DbStatementOutcome {
  /** Every result it answered with, each cut at the run's row limit. */
  resultSets: { columns: ResultColumn[]; rows: unknown[][]; truncated: boolean }[];
  /** Rows it wrote, when the engine counts them. */
  rowsAffected?: number;
  /** The server's name for it (`SELECT`, `CREATE TABLE`), when it gives one. */
  command?: string;
  /** What the server said while it ran. */
  notices: string[];
}

/**
 * The Query tab's session: one connection for a whole run, so a SET, a temporary table or a BEGIN
 * in one statement holds for the next, and closed when the run ends — what a script changed about
 * its session goes with it rather than to the next borrower of a pooled connection.
 */
export interface DbQuerySession {
  /** How this server reads a statement: the script is split the way it will be run. */
  readonly splitOptions: SqlLexOptions;
  /**
   * Run one statement typed by a person, keeping no more than `maxRows` rows of each result.
   * Throws `QueryStatementError` (`db-errors.ts`).
   */
  run(sql: string, maxRows: number): Promise<DbStatementOutcome>;
  /** Stop: the statement running now ends early, or fails with the database's own error. */
  cancel(): void;
  /** Roll back a transaction the script began and did not end; true when there was one. */
  rollbackOpenTransaction(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Import's writes into one table: a transaction on a connection of its own, so a failure or a Stop
 * takes back every row the run wrote, and a slow file never holds a pooled connection.
 */
export interface DbWriteSession {
  /**
   * DDL before the rows: CREATE, DROP, TRUNCATE. Inside the transaction on Postgres and SQLite;
   * MySQL commits each of them by itself, and the session then opens its transaction again.
   */
  ddl(sql: string): Promise<void>;
  /** One statement; how many rows it wrote. Throws the driver's own error. */
  run(stmt: DbStatement): Promise<number>;
  commit(): Promise<void>;
  /** Roll back what was not committed and let the connection go. Safe to call twice, and after commit. */
  close(): Promise<void>;
  /** Stop: cancel the statement running on the server, which then fails with the database's own error. */
  cancel(): void;
  /**
   * Parameters one statement may bind on this connection: 65,535 for Postgres and MySQL, what
   * this SQLite library was built with (32,766 since SQLite 3.32, 999 before).
   */
  readonly maxParams: number;
}

export interface DatabaseAdapter {
  testConnection(config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }>;
  /**
   * Connect on a connection of its own, read the version and the databases, and close it, so a
   * test leaves no pool behind holding a password nobody saved. Throws the driver's own error.
   */
  probe(config: DbConnectionConfig): Promise<DbProbe>;
  /** Close what `config` has open — its pools, readonly or not — so nothing goes on holding its login. */
  close(config: DbConnectionConfig): Promise<void>;
  /** Every database the login can open, the server's own left out, as the tree lists them; empty for SQLite. */
  listDatabases(config: DbConnectionConfig): Promise<string[]>;
  getTables(config: DbConnectionConfig): Promise<DbTableInfo[]>;
  getTableSchema(config: DbConnectionConfig, table: string, schema?: string): Promise<DbColumnInfo[]>;
  getTableData(config: DbConnectionConfig, table: string, opts: {
    schema?: string; page?: number; limit?: number; orderBy?: string; orderDir?: "ASC" | "DESC";
  }): Promise<DbPagedData>;
  executeQuery(config: DbConnectionConfig, sql: string): Promise<DbQueryResult>;
  /** Columns and row key of a table, view or materialized view; null when it does not exist. */
  describeTable(config: DbConnectionConfig, table: string, schema?: string): Promise<DbCatalogTable | null>;
  /** Run one parameterised SELECT built by the grid. Never runs a second statement. */
  selectRows(config: DbConnectionConfig, stmt: DbStatement): Promise<DbRowSet>;
  /**
   * Export's read: one SELECT built by the server, its rows handed over in batches within
   * `limits`, each batch read only once the one before has been taken. It runs on a connection of its
   * own — a pooled one would be held for as long as the download takes — inside a READ ONLY
   * transaction, and the values are the driver's own: bytes in full, 64-bit integers exact.
   * Ending the iteration early closes the cursor and the connection; `close()` ends it too.
   */
  streamRows(config: DbConnectionConfig, stmt: DbStatement, limits: BatchLimits, opts?: StreamRowsOptions): AsyncGenerator<unknown[][]>;
  /** Exact `COUNT(*)` from `stmt`, or null when it takes longer than `timeoutMs`. */
  countRows(config: DbConnectionConfig, stmt: DbStatement, timeoutMs: number): Promise<number | null>;
  /** The engine's own estimate of a whole table's rows, when it keeps statistics. */
  estimateRows(config: DbConnectionConfig, table: string, schema?: string): Promise<number | null>;
  /** Run SQL typed by the user; columns come from the driver, rows as arrays. */
  runQuery(config: DbConnectionConfig, sql: string, opts?: RunQueryOptions): Promise<DbRunResult>;
  /** The Query tab's session for one run (see `DbQuerySession`). */
  openQuerySession(config: DbConnectionConfig): Promise<DbQuerySession>;
  /** Tables, views, routines, triggers and sequences, per schema. */
  listObjects(config: DbConnectionConfig): Promise<DbObjectList>;
  /** Every column of every table and view, in column order: what searching by column reads. */
  listColumns(config: DbConnectionConfig): Promise<DbColumnRef[]>;
  /** Everything the catalog says about one table or view; null when it does not exist. */
  getStructure(config: DbConnectionConfig, table: string, schema?: string): Promise<DbTableStructure | null>;
  /** Every foreign key in the database, for walking reference chains. */
  listForeignKeys(config: DbConnectionConfig): Promise<DbForeignKey[]>;
  /** The object's CREATE statement, as a script that runs again on an empty database; null when it does not exist. */
  getObjectSql(config: DbConnectionConfig, obj: DbObjectRef): Promise<string | null>;
  /**
   * Run a changeset's statements in one transaction and return the rows each
   * hit. Throws `ChangesetStatementError` — with nothing written — on the first
   * failure or on an UPDATE/DELETE that did not hit exactly one row.
   */
  applyChangeset(config: DbConnectionConfig, statements: ChangesetStatement[]): Promise<number[]>;
  /**
   * The DDL that turns `base` into `current` here: Postgres and MySQL write it for the server's
   * version, SQLite from the table's own schema text, which a rebuild copies. `references` are the
   * keys other tables hold on it.
   */
  planAlterTable(config: DbConnectionConfig, base: TableModel, current: TableModel, diff: TableDiff, references: DbForeignKey[]): Promise<DdlPlan>;
  /**
   * Run a DDL plan: in one transaction on Postgres and SQLite, statement by statement on MySQL,
   * where DDL commits on its own. Throws `DdlApplyError` naming the statement that failed.
   */
  applyDdl(config: DbConnectionConfig, plan: DdlPlan): Promise<void>;
  /**
   * Import's writer (see `DbWriteSession`), its transaction begun. Throws `ReadonlyViolationError`
   * on a readonly connection, before anything is opened.
   */
  openWriteSession(config: DbConnectionConfig): Promise<DbWriteSession>;
}
