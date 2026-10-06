/**
 * MySQL and MariaDB, through the `mysql2` driver installed from Settings.
 *
 * Only types come from `mysql2` at build time; the module itself is loaded
 * from the installed bundle on first use (`drivers/db-driver-loader.ts`), so a
 * PPM without the driver still starts, lists the connection, and answers its
 * routes with an Install prompt instead of failing to boot.
 *
 * What the pools are configured for, each measured on MySQL 8.4 and MariaDB 11
 * (`plans/…/reports/02-mysql-driver.md`):
 *
 * - values arrive as the server prints them: `dateStrings` (a DATETIME must
 *   not be re-read in PPM's time zone), BIGINT and DECIMAL as strings, JSON as
 *   its text;
 * - parameters always go through a prepared statement (`execute`), never
 *   through the driver's own escaping, which is wrong on a server running
 *   `NO_BACKSLASH_ESCAPES` — a real injection, not a cosmetic bug;
 * - `multipleStatements` stays off: PPM splits a script itself, the same way
 *   the editor shows it, `DELIMITER` included;
 * - each new session runs `SET NAMES utf8mb4`, taking the server's default
 *   collation instead of the driver's (`utf8mb4_unicode_ci`), which otherwise
 *   fails comparisons with "Illegal mix of collations";
 * - `LOCAL_FILES` is turned off, so no statement can make the server read a
 *   file off PPM's host.
 */
import type { Readable } from "node:stream";
import type { FieldPacket, Pool, PoolConnection, PoolOptions, ResultSetHeader } from "mysql2/promise";
import { parseDbUrl } from "../shared/db-connection-url.ts";
import { splitSqlStatements, sqlCode } from "../shared/split-sql-statements.ts";
import { rowsToRecords, type ResultColumn } from "../shared/db-grid.ts";
import type { DbColumnRef, DbForeignKey, DbObjectList, DbObjectRef, DbTableStructure } from "../shared/db-structure.ts";
import { mysqlObjectSql } from "./database/object-sql-mysql.ts";
import type {
  DbCatalogTable, DbColumnInfo, DbPagedData, DbProbe, DbQuerySession, DbQueryResult, DbRowSet, DbRunResult, DbStatement, DbStatementOutcome,
  DbTableInfo, DbWriteSession, StreamRowsOptions,
} from "../types/database.ts";
import {
  MYSQL_SYSTEM_SCHEMAS, mysqlDescribeTable, mysqlGetStructure, mysqlListColumns, mysqlListForeignKeys, mysqlListObjects, mysqlListTables,
  mysqlServerInfo, mysqlTableColumns, parseServerVersion, type MysqlRead, type MysqlServerInfo,
} from "./database/analyser-mysql.ts";
import { ChangesetStatementError, checkAffected, type ChangesetStatement } from "./database/changeset.ts";
import { QueryStatementError, READONLY_IMPORT, READONLY_STRUCTURE, ReadonlyViolationError } from "./database/db-errors.ts";
import { toJsonValue } from "./database/db-values.ts";
import { RowBatcher, type BatchLimits } from "./database/export-batch.ts";
import { mysqlAlterTable } from "./database/ddl/ddl-mysql.ts";
import { DdlApplyError, ddlErrorMessage, type DdlPlan } from "./database/ddl/ddl-types.ts";
import type { TableDiff } from "./database/ddl/table-diff.ts";
import type { TableModel } from "../shared/db-table-model.ts";
import { mysqlDialect } from "./database/dialect-mysql.ts";
import { loadDbDriver, onDbDriverUnload } from "./database/drivers/db-driver-loader.ts";
import { isReadOnlyQuery } from "./database/readonly-check.ts";
import { isolationLevelSql } from "./database/isolation-level.ts";
import { connectionLogTarget as logTarget, readCertificateFiles, takeEndpoint } from "./database/connection-endpoint.ts";
import { sshChannelStream } from "./database/ssh-tunnel.ts";
import { installTlsIdentityCheck } from "./database/tls-identity-check.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("db");

type Mysql2 = { createPool(options: PoolOptions): Pool };

// VERIFY_IDENTITY checks the certificate's name for a server named by IP address too.
installTlsIdentityCheck();

/** Close a pool nobody used for this long. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** DNS + TCP + TLS + auth. Matches the Postgres service. */
const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_RETRIES = 1;
const RETRY_DELAY_MS = 250;
/** An export's `net_write_timeout`: longer than its download may go without taking a byte (300 s). */
const EXPORT_WRITE_TIMEOUT_SEC = 900;
/** Rows an export's stream holds before mysql2 pauses the socket. */
const STREAM_WAITING_ROWS = 16;
/** Placeholders one prepared statement may have. */
const MYSQL_MAX_PARAMS = 65_535;
/**
 * The server counts prepared statements across *every* client
 * (`max_prepared_stmt_count`, 16 382 by default) and mysql2 caches 16 000 per
 * connection unless told otherwise; three pooled connections must not starve
 * the applications that share the server.
 */
const MAX_PREPARED_STATEMENTS = 32;

/** Failures before anything was sent, so trying again cannot run a write twice. */
const RETRYABLE_CONNECT_ERRORS = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]);

/** `KILL QUERY` from another session, and MySQL's `max_execution_time`. */
const ER_QUERY_INTERRUPTED = 1317;
/** Server status flag: the session is inside a transaction. */
const SERVER_STATUS_IN_TRANS = 0x0001;

/** Column type codes from the protocol, for the few that need handling and for naming result columns. */
const MYSQL_TYPE = { FLOAT: 4, BIT: 16 } as const;
const TYPE_NAMES: Record<number, string> = {
  0: "decimal", 1: "tinyint", 2: "smallint", 3: "int", 4: "float", 5: "double", 6: "null", 7: "timestamp", 8: "bigint",
  9: "mediumint", 10: "date", 11: "time", 12: "datetime", 13: "year", 14: "date", 15: "varchar", 16: "bit", 17: "timestamp",
  18: "datetime", 19: "time", 245: "json", 246: "decimal", 247: "enum", 248: "set", 249: "tinyblob", 250: "mediumblob",
  251: "longblob", 252: "blob", 253: "varchar", 254: "char", 255: "geometry",
};
const FLAG = { UNSIGNED: 32, ENUM: 256, SET: 2048 } as const;
/** The `binary` character set: a string type holding bytes. */
const BINARY_CHARSET = 63;
const NUMERIC_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 246]);

/** The callback connection under a promise one: its `execute` hands back a command whose rows can be read as a stream. */
interface StreamableConnection {
  execute(options: { sql: string; rowsAsArray: boolean }, values: unknown[]): { stream(options: { highWaterMark: number }): Readable };
}

/** A job's connection, on a pool of its own. */
interface JobConnection {
  conn: PoolConnection;
  pool: Pool;
}

interface CachedPool {
  pool: Pool;
  timer: ReturnType<typeof setTimeout>;
  info?: Promise<MysqlServerInfo>;
}

/**
 * Statements whose row count, when they return no rows, is the rows they wrote. `WITH` begins a
 * write here: one that reads returns rows.
 */
const WRITE_STATEMENT = /^\s*(insert|update|delete|replace|with)\b/i;

/** A failed Query tab statement, carrying the line MySQL says the error is on (`… at line 3`). */
function mysqlStatementError(e: unknown): QueryStatementError {
  const err = e as { sqlMessage?: unknown; fatal?: unknown } | null;
  const message = typeof err?.sqlMessage === "string" && err.sqlMessage ? err.sqlMessage : mysqlErrorMessage(e);
  const line = Number(/ at line (\d+)$/.exec(message)?.[1]);
  return new QueryStatementError(message, Number.isInteger(line) && line > 0 ? { line } : {}, e, err?.fatal === true);
}

/** What a failed MySQL call said. A dual-stack connect fails with an AggregateError whose own message is empty. */
export function mysqlErrorMessage(e: unknown): string {
  const err = e as { message?: string; code?: string; errors?: { message?: string }[] } | null;
  if (err?.message) return err.message;
  const inner = err?.errors?.map((x) => x.message).filter(Boolean).join("; ");
  return inner || err?.code || String(e);
}

type SslMode = "disabled" | "required" | "verify-ca" | "verify-identity";

/** The TLS version of `conn`, null in plain text (`Ssl_version` is empty then); undefined when the server would not say. */
async function mysqlTls(conn: PoolConnection): Promise<string | null | undefined> {
  try {
    const [rows] = await conn.query("SHOW SESSION STATUS LIKE 'Ssl_version'") as unknown as [Record<string, unknown>[]];
    const row = rows[0];
    if (!row) return undefined;
    const value = String(row.Value ?? row.VALUE ?? "");
    return value || null;
  } catch {
    return undefined;
  }
}

/** Every spelling a MySQL or Postgres connection string uses, by the check it asks for. */
const SSL_MODES: Record<string, SslMode> = {
  disable: "disabled", disabled: "disabled", false: "disabled", "0": "disabled",
  // mysql2 has no "TLS when the server offers it", so PREFERRED connects in plain text, as mysql2 does by default.
  prefer: "disabled", preferred: "disabled",
  require: "required", required: "required", "no-verify": "required", true: "required", "1": "required",
  "verify-ca": "verify-ca", verify_ca: "verify-ca",
  "verify-full": "verify-identity", "verify-identity": "verify-identity", verify_identity: "verify-identity",
};

/** A fresh object each time: mysql2 writes into the one it is given. */
function sslOptions(mode: SslMode): PoolOptions["ssl"] | undefined {
  switch (mode) {
    case "disabled": return undefined;
    // Encrypted, certificate not checked — what REQUIRED means to the mysql client.
    case "required": return { rejectUnauthorized: false };
    // The chain is checked; only VERIFY_IDENTITY also checks the host name.
    case "verify-ca": return { rejectUnauthorized: true };
    case "verify-identity": return { rejectUnauthorized: true, verifyIdentity: true };
  }
}

/**
 * Pool options from a `mysql://user:pass@host:port/db` (or `mariadb://`)
 * string. TLS follows `ssl-mode` (MySQL's spelling), `sslmode` (Postgres') or
 * `ssl`; `socket` names a Unix socket instead of a host — a URL with a login
 * and no host, which `new URL()` refuses, hence the shared reader.
 */
export function mysqlPoolOptions(connectionString: string): PoolOptions {
  const { url: bare, endpoint } = takeEndpoint(connectionString);
  const parsed = parseDbUrl(bare);
  if (parsed.kind !== "url") {
    const why = parsed.kind === "error" ? ` (${parsed.error})` : "";
    throw new Error(`Invalid MySQL connection string${why} — expected mysql://user:password@host:3306/database`);
  }
  const url = parsed.parts;
  if (url.type === "postgres") {
    throw new Error("A MySQL connection string starts with mysql:// (or mariadb://)");
  }
  const mode = url.ssl ? SSL_MODES[url.ssl.value.toLowerCase()] : "disabled";
  if (mode === undefined) {
    throw new Error(`Unknown ${url.ssl!.name} "${url.ssl!.value}" — use disabled, required, verify_ca or verify_identity`);
  }
  // The SSL tab's files, with SSL on only: mysql2 reads them from the same object.
  const files = endpoint?.profile.ssl;
  const tls = sslOptions(mode);
  const ssl = tls && typeof tls === "object" && files ? { ...tls, ...readCertificateFiles(files) } : tls;
  const ssh = endpoint?.profile.ssh;
  return {
    // Still the database's own address through a tunnel: mysql2 names it to TLS as the server name.
    host: url.host || "localhost",
    port: url.port ?? 3306,
    user: url.user || undefined,
    password: url.password || undefined,
    database: url.database || undefined,
    ...(url.socket ? { socketPath: url.socket } : {}),
    ...(ssl ? { ssl } : {}),
    // Called for each new connection; it has to answer at once, so it is a stream the channel is
    // joined to once it opens.
    ...(endpoint && ssh ? { stream: () => sshChannelStream(endpoint.id, ssh, endpoint.target) } : {}),
    connectionLimit: 3,
    maxIdle: 3,
    idleTimeout: 60_000,
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableKeepAlive: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
    multipleStatements: false,
    maxPreparedStatements: MAX_PREPARED_STATEMENTS,
    flags: ["-LOCAL_FILES"],
  };
}

/** A FLOAT read through a prepared statement is its float32 value widened (1.100000023841858); show the shortest text that is still that float32. */
export function shortestFloat32(value: number): number {
  if (!Number.isFinite(value)) return value;
  const f = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === f) return candidate;
  }
  return value;
}

/** BIT(n) arrives as big-endian bytes; the grid shows the number, as DBGate does. */
export function bitValue(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function fieldType(field: FieldPacket | undefined): number {
  return field?.columnType ?? field?.type ?? -1;
}

/** A value as the server meant it: a BIT's number, a FLOAT's own digits; everything else as the driver read it. */
function rawValue(value: unknown, field: FieldPacket | undefined): unknown {
  if (value == null) return null;
  const type = fieldType(field);
  if (type === MYSQL_TYPE.BIT && value instanceof Uint8Array) return bitValue(value);
  if (type === MYSQL_TYPE.FLOAT && typeof value === "number") return shortestFloat32(value);
  return value;
}

function normalizeValue(value: unknown, field: FieldPacket | undefined): unknown {
  return toJsonValue(rawValue(value, field));
}

function normalizeRows(rows: unknown[][], fields: FieldPacket[]): unknown[][] {
  return rows.map((row) => row.map((v, i) => normalizeValue(v, fields[i])));
}

/** A result column's type as the server would print it, from the protocol's type code and flags. */
export function resultColumnType(field: FieldPacket): string {
  if (field.extendedTypeName) return field.extendedTypeName;
  const flags = typeof field.flags === "number" ? field.flags : 0;
  const type = fieldType(field);
  const bytes = (field.characterSet ?? field.charsetNr) === BINARY_CHARSET;
  if (flags & FLAG.ENUM) return "enum";
  if (flags & FLAG.SET) return "set";
  if (type >= 249 && type <= 252) return bytes ? TYPE_NAMES[type]! : TYPE_NAMES[type]!.replace("blob", "text");
  if (type === 253) return bytes ? "varbinary" : "varchar";
  if (type === 254) return bytes ? "binary" : "char";
  if (type === 1 && field.columnLength === 1) return "tinyint(1)";
  const name = TYPE_NAMES[type] ?? `type ${type}`;
  return NUMERIC_TYPES.has(type) && flags & FLAG.UNSIGNED ? `${name} unsigned` : name;
}

function describeFields(fields: FieldPacket[] | undefined): ResultColumn[] {
  return (fields ?? []).map((f) => ({ name: f.name, type: resultColumnType(f) }));
}

type QueryAnswer = [unknown, FieldPacket[] | FieldPacket[][] | undefined];

/** Rows and the row count of what one statement answered; a CALL answers with several results. */
function readAnswer([result, fields]: QueryAnswer): { rowSets: { rows: unknown[][]; fields: FieldPacket[] }[]; affected: number } {
  const multi = Array.isArray(fields) && fields.length > 0 && (Array.isArray(fields[0]) || fields[0] === undefined);
  const parts: [unknown, FieldPacket[] | undefined][] = multi
    ? (result as unknown[]).map((r, i) => [r, (fields as (FieldPacket[] | undefined)[])[i]])
    : [[result, fields as FieldPacket[] | undefined]];
  const rowSets: { rows: unknown[][]; fields: FieldPacket[] }[] = [];
  let affected = 0;
  for (const [r, f] of parts) {
    if (Array.isArray(r) && f) rowSets.push({ rows: r as unknown[][], fields: f });
    else affected += Number((r as ResultSetHeader | undefined)?.affectedRows ?? 0);
  }
  return { rowSets, affected };
}

export interface ListingOptions {
  /** List every database, not only the one the URL names: the form's "Use only database" unticked. */
  allDatabases?: boolean;
}

/** What a listing looks at. Statements still run in the URL's database either way. */
function listingScope(info: MysqlServerInfo, options: ListingOptions): MysqlServerInfo {
  return options.allDatabases ? { ...info, database: null } : info;
}

class MysqlService {
  private pools = new Map<string, Promise<CachedPool>>();
  /** The connections an export reads on or an import writes on, by connection string, which `close()` ends with the pool. */
  private jobConnections = new Map<string, Set<PoolConnection>>();

  constructor() {
    onDbDriverUnload("mysql", () => this.closeAll());
  }

  /** Statements every new session of this service's pools runs first. */
  protected sessionInit(): string[] {
    return ["SET NAMES utf8mb4"];
  }

  private cachedPool(connectionString: string): Promise<CachedPool> {
    let pending = this.pools.get(connectionString);
    if (!pending) {
      pending = this.createPool(connectionString);
      this.pools.set(connectionString, pending);
      pending.catch(() => { if (this.pools.get(connectionString) === pending) this.pools.delete(connectionString); });
    }
    return pending.then((cached) => {
      clearTimeout(cached.timer);
      cached.timer = setTimeout(() => this.disconnect(connectionString, "idle"), IDLE_TIMEOUT_MS);
      return cached;
    });
  }

  private async createPool(connectionString: string): Promise<CachedPool> {
    const options = mysqlPoolOptions(connectionString);
    const mysql = await loadDbDriver<Mysql2>("mysql");
    const pool = mysql.createPool(options);
    const init = this.sessionInit();
    // The core pool's event, whose connection has the callback API: the
    // statements queue ahead of whatever the caller who asked for it sends.
    pool.pool.on("connection", (conn: { query(sql: string, cb: (err: unknown) => void): unknown; destroy(): void }) => {
      for (const sql of init) {
        conn.query(sql, (err) => {
          if (!err) return;
          const why = (err as { code?: unknown }).code ?? (err as Error).message;
          log.warn(`mysql session init "${sql}" failed on ${logTarget(connectionString)}: ${String(why).slice(0, 200)} — connection dropped`);
          conn.destroy();
        });
      }
    });
    log.info(`mysql pool opened ${logTarget(connectionString)}${this instanceof ReadonlyMysqlService ? " readonly" : ""}`);
    return { pool, timer: setTimeout(() => this.disconnect(connectionString, "idle"), IDLE_TIMEOUT_MS) };
  }

  /** `reason` is for the log. */
  private async disconnect(connectionString: string, reason: string): Promise<void> {
    const pending = this.pools.get(connectionString);
    if (!pending) return;
    log.info(`mysql pool closed ${logTarget(connectionString)}${this instanceof ReadonlyMysqlService ? " readonly" : ""}: ${reason}`);
    this.pools.delete(connectionString);
    try {
      const cached = await pending;
      clearTimeout(cached.timer);
      await cached.pool.end();
    } catch { /* never opened, or already closed */ }
  }

  /**
   * A connection from the pool. Only getting one is retried: a failure there
   * is before any statement left, where the first connect over a cold VPN
   * path can fail and an immediate second attempt succeed.
   */
  protected async acquire(connectionString: string): Promise<PoolConnection> {
    for (let attempt = 0; ; attempt++) {
      const { pool } = await this.cachedPool(connectionString);
      try {
        return await pool.getConnection();
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        if (attempt >= CONNECT_RETRIES || typeof code !== "string" || !RETRYABLE_CONNECT_ERRORS.has(code)) throw e;
        log.warn(`mysql connect to ${logTarget(connectionString)} failed (${code}), retrying in ${RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  /** Run on one connection, returned to the pool afterwards — or closed, when `fn` left it unfit to share. */
  protected async withConnection<T>(connectionString: string, fn: (conn: PoolConnection) => Promise<T>, opts: { discard?: boolean } = {}): Promise<T> {
    const conn = await this.acquire(connectionString);
    let broken = false;
    try {
      return await fn(conn);
    } catch (e) {
      // A lost connection is no use to the next borrower either.
      if ((e as { fatal?: boolean } | null)?.fatal) broken = true;
      throw e;
    } finally {
      if (opts.discard || broken) conn.destroy();
      else conn.release();
    }
  }

  protected async serverInfo(connectionString: string, read: MysqlRead): Promise<MysqlServerInfo> {
    const cached = await this.cachedPool(connectionString);
    cached.info ??= mysqlServerInfo(read);
    cached.info.catch(() => { cached.info = undefined; });
    return cached.info;
  }

  private reader(conn: PoolConnection): MysqlRead {
    return async (sql, params = []) => {
      const [rows] = await conn.execute({ sql }, params as never[]);
      return rows as Record<string, unknown>[];
    };
  }

  /** Catalog reads on one connection, with the server's description at hand. */
  protected withCatalog<T>(connectionString: string, fn: (read: MysqlRead, info: MysqlServerInfo) => Promise<T>): Promise<T> {
    return this.withConnection(connectionString, async (conn) => {
      const read = this.reader(conn);
      return fn(read, await this.serverInfo(connectionString, read));
    });
  }

  async testConnection(connectionString: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.withConnection(connectionString, (conn) => conn.query("SELECT 1"));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: mysqlErrorMessage(e) };
    }
  }

  /**
   * One connection, closed again: the server's version and the databases the login can open.
   * Nothing is cached, so a login typed only to be tested is not kept by a pool.
   */
  async probe(connectionString: string): Promise<DbProbe> {
    const options = mysqlPoolOptions(connectionString);
    const mysql = await loadDbDriver<Mysql2>("mysql");
    const pool = mysql.createPool({ ...options, connectionLimit: 1, maxIdle: 1 });
    try {
      const conn = await pool.getConnection();
      try {
        const [[row]] = await conn.query("SELECT VERSION() AS version") as unknown as [Record<string, unknown>[]];
        const [dbRows] = await conn.query("SHOW DATABASES") as unknown as [Record<string, unknown>[]];
        const { mariadb, version } = parseServerVersion(String(row?.version ?? ""));
        const system = new Set<string>(MYSQL_SYSTEM_SCHEMAS);
        const databases = dbRows.map((r) => String(Object.values(r)[0] ?? "")).filter((d) => d && !system.has(d));
        return { version: `${mariadb ? "MariaDB" : "MySQL"} ${version.join(".")}`, databases, tls: await mysqlTls(conn) };
      } finally {
        conn.release();
      }
    } finally {
      pool.end().catch(() => {});
    }
  }

  /** The databases the login can open, the server's own left out; as `probe` lists them. */
  async listDatabases(connectionString: string): Promise<string[]> {
    const rows = await this.withConnection(connectionString, async (conn) => {
      const [result] = await conn.query("SHOW DATABASES") as unknown as [Record<string, unknown>[]];
      return result;
    });
    const system = new Set<string>(MYSQL_SYSTEM_SCHEMAS);
    return rows.map((r) => String(Object.values(r)[0] ?? "")).filter((d) => d && !system.has(d));
  }

  async getTables(connectionString: string, options: ListingOptions = {}): Promise<DbTableInfo[]> {
    return this.withCatalog(connectionString, (read, info) => mysqlListTables(read, listingScope(info, options)));
  }

  async getTableSchema(connectionString: string, table: string, schema?: string): Promise<DbColumnInfo[]> {
    return this.withCatalog(connectionString, (read) => mysqlTableColumns(read, table, schema ?? null));
  }

  async describeTable(connectionString: string, table: string, schema?: string): Promise<DbCatalogTable | null> {
    return this.withCatalog(connectionString, (read) => mysqlDescribeTable(read, table, schema ?? null));
  }

  async listObjects(connectionString: string, options: ListingOptions = {}): Promise<DbObjectList> {
    return this.withCatalog(connectionString, (read, info) => mysqlListObjects(read, listingScope(info, options)));
  }

  async listColumns(connectionString: string, options: ListingOptions = {}): Promise<DbColumnRef[]> {
    return this.withCatalog(connectionString, (read, info) => mysqlListColumns(read, listingScope(info, options)));
  }

  async getStructure(connectionString: string, table: string, schema?: string): Promise<DbTableStructure | null> {
    return this.withCatalog(connectionString, (read, info) => mysqlGetStructure(read, info, schema ?? null, table));
  }

  async listForeignKeys(connectionString: string): Promise<DbForeignKey[]> {
    return this.withCatalog(connectionString, (read) => mysqlListForeignKeys(read));
  }

  /** Sent as plain queries: not every server can prepare `SHOW CREATE TRIGGER` and its kin. */
  async getObjectSql(connectionString: string, obj: DbObjectRef): Promise<string | null> {
    return this.withConnection(connectionString, async (conn) => {
      const info = await this.serverInfo(connectionString, this.reader(conn));
      const show: MysqlRead = async (sql) => {
        const [rows] = await conn.query({ sql });
        return rows as Record<string, unknown>[];
      };
      return mysqlObjectSql(show, info.database, obj);
    });
  }

  /** `TABLE_ROWS`: InnoDB's estimate, refreshed on the server's own schedule; null for a view. */
  async estimateRows(connectionString: string, table: string, schema?: string): Promise<number | null> {
    const rows = await this.withCatalog(connectionString, (read) => read(`
      SELECT TABLE_ROWS AS row_estimate FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`, [schema ?? null, table]));
    const estimate = rows[0]?.row_estimate == null ? NaN : Number(rows[0].row_estimate);
    return Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
  }

  /** One grid SELECT, prepared: MySQL refuses a second statement in a prepared one, which keeps a `{$$ …}` condition inside it. */
  async selectRows(connectionString: string, stmt: DbStatement): Promise<DbRowSet> {
    return this.withConnection(connectionString, (conn) => this.select(conn, stmt));
  }

  protected async select(conn: PoolConnection, stmt: DbStatement): Promise<DbRowSet> {
    const [rows, fields] = await conn.execute({ sql: stmt.sql, rowsAsArray: true }, stmt.params as never[]);
    return { columns: describeFields(fields), rows: normalizeRows(rows as unknown[][], fields) };
  }

  /**
   * Export's read, streamed: mysql2 pauses the socket while the rows read so far wait to be taken,
   * so a download as slow as the browser's holds the server back instead of filling PPM's memory.
   * On a pool of one connection of its own, destroyed at the end — a result read halfway cannot
   * go back to a pool — inside `START TRANSACTION READ ONLY`. Only getting the connection is
   * retried: nothing has been sent by then.
   *
   * The server gives up on a client that takes nothing for `net_write_timeout` seconds — 60 by
   * default, shorter than a download may pause — so the session raises it past the download's own
   * idle limit.
   */
  async *streamRows(connectionString: string, stmt: DbStatement, limits: BatchLimits, opts: StreamRowsOptions = {}): AsyncGenerator<unknown[][]> {
    let { onColumns } = opts;
    const { signal } = opts;
    signal?.throwIfAborted();
    const job = await this.openJobConnection(connectionString);
    const { conn } = job;
    try {
      await conn.query(`SET SESSION net_write_timeout = ${EXPORT_WRITE_TIMEOUT_SEC}`);
      await conn.query("START TRANSACTION READ ONLY");
      const command = (conn.connection as unknown as StreamableConnection).execute({ sql: stmt.sql, rowsAsArray: true }, stmt.params);
      // Rows waiting in the stream are not counted against the batch's bytes, so few may wait.
      const rows = command.stream({ highWaterMark: STREAM_WAITING_ROWS });
      let fields: FieldPacket[] = [];
      rows.on("fields", (f: FieldPacket[]) => { fields = f; });
      // The fields arrive before the first row and, for a statement that finds none, before the end.
      const describe = (): void => {
        onColumns?.(describeFields(fields));
        onColumns = undefined;
      };
      // A stop kills the statement on the server, which may still be sorting with no row sent yet.
      const threadId = conn.threadId;
      const stop = (): void => {
        void this.killQuery(connectionString, threadId);
        rows.destroy(new Error("The read was stopped"));
      };
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const batcher = new RowBatcher(limits);
        for await (const row of rows) {
          const batch = batcher.add((row as unknown[]).map((v, i) => rawValue(v, fields[i])));
          if (batch) {
            describe();
            yield batch;
          }
        }
        describe();
        const last = batcher.take();
        if (last.length) yield last;
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    } finally {
      this.endJobConnection(connectionString, job);
    }
  }

  /**
   * Import's writer (see `DbWriteSession`), inside `START TRANSACTION` on a connection of its own.
   * MySQL commits CREATE, DROP and TRUNCATE by themselves — the transaction open around them with
   * them — so after each one the transaction is opened again. Stop kills the statement running from
   * a second session, as a count's timeout does.
   */
  async openWriteSession(connectionString: string): Promise<DbWriteSession> {
    const job = await this.openJobConnection(connectionString);
    const { conn } = job;
    try {
      await conn.query("START TRANSACTION");
    } catch (e) {
      this.endJobConnection(connectionString, job);
      throw e;
    }
    let ended = false;
    let running = false;
    const send = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (ended) throw new Error("The import's connection is closed");
      running = true;
      try {
        return await fn();
      } finally {
        running = false;
      }
    };
    const end = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      this.endJobConnection(connectionString, job);
    };
    return {
      maxParams: MYSQL_MAX_PARAMS,
      ddl: (sql) => send(async () => {
        await conn.query({ sql });
        await conn.query("START TRANSACTION");
      }),
      run: (stmt) => send(async () => {
        const [result] = await conn.execute<ResultSetHeader>({ sql: stmt.sql }, stmt.params as never[]);
        return Number(result.affectedRows ?? 0);
      }),
      commit: async () => {
        await send(() => conn.query("COMMIT"));
        await end();
      },
      close: end,
      cancel: () => {
        if (running) void this.killQuery(connectionString, conn.threadId);
      },
    };
  }

  /**
   * A connection of its own for a job, on a pool of one ended with it: a result read halfway, or a
   * transaction left open, cannot go back to a shared pool. Only getting the connection is retried —
   * nothing has been sent by then. `close()` ends it with the pool.
   */
  private async openJobConnection(connectionString: string): Promise<JobConnection> {
    const mysql = await loadDbDriver<Mysql2>("mysql");
    const pool = mysql.createPool({ ...mysqlPoolOptions(connectionString), connectionLimit: 1, maxIdle: 1 });
    let conn: PoolConnection;
    for (let attempt = 0; ; attempt++) {
      try {
        conn = await pool.getConnection();
        break;
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        if (attempt >= CONNECT_RETRIES || typeof code !== "string" || !RETRYABLE_CONNECT_ERRORS.has(code)) {
          pool.end().catch(() => {});
          throw e;
        }
        log.warn(`mysql connect to ${logTarget(connectionString)} failed (${code}), retrying in ${RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    const job = { conn, pool };
    this.jobConnections.set(connectionString, (this.jobConnections.get(connectionString) ?? new Set<PoolConnection>()).add(conn));
    try {
      for (const sql of this.sessionInit()) await conn.query(sql);
    } catch (e) {
      this.endJobConnection(connectionString, job);
      throw e;
    }
    return job;
  }

  /** Ends a job's connection and its pool: the server rolls back a transaction it left open. */
  private endJobConnection(connectionString: string, { conn, pool }: JobConnection): void {
    const conns = this.jobConnections.get(connectionString);
    if (conns?.delete(conn) && !conns.size) this.jobConnections.delete(connectionString);
    conn.destroy();
    pool.end().catch(() => {});
  }

  /**
   * `COUNT(*)`, given up after `timeoutMs` with `KILL QUERY` from a second
   * session — the one way to stop a statement that both servers share. The
   * counting connection is held until the kill has landed and is then closed
   * rather than pooled, so the kill can never reach whoever borrows it next.
   */
  async countRows(connectionString: string, stmt: DbStatement, timeoutMs: number): Promise<number | null> {
    return this.countOn(connectionString, stmt, timeoutMs, (conn) => this.count(conn, stmt));
  }

  protected async count(conn: PoolConnection, stmt: DbStatement): Promise<number> {
    const [rows] = await conn.execute({ sql: stmt.sql }, stmt.params as never[]);
    return Number((rows as { count?: unknown }[])[0]?.count ?? 0);
  }

  protected async countOn(
    connectionString: string, stmt: DbStatement, timeoutMs: number, run: (conn: PoolConnection) => Promise<number>,
  ): Promise<number | null> {
    const conn = await this.acquire(connectionString);
    const timeout: { kill: Promise<void> | null } = { kill: null };
    const timer = setTimeout(() => { timeout.kill = this.killQuery(connectionString, conn.threadId); }, Math.max(1, Math.round(timeoutMs)));
    try {
      return await run(conn);
    } catch (e) {
      if (timeout.kill && (e as { errno?: number }).errno === ER_QUERY_INTERRUPTED) return null;
      throw e;
    } finally {
      clearTimeout(timer);
      if (timeout.kill) {
        await timeout.kill;
        conn.destroy();
      } else conn.release();
    }
  }

  private async killQuery(connectionString: string, threadId: number): Promise<void> {
    if (!Number.isInteger(threadId) || threadId <= 0) return;
    try {
      await this.withConnection(connectionString, (conn) => conn.query(`KILL QUERY ${threadId}`));
    } catch { /* the statement ended on its own, or the server is gone */ }
  }

  /**
   * A changeset in one transaction, statement by statement, counting the rows
   * each one *matched* — mysql2 connects with `FOUND_ROWS`, so an UPDATE that
   * writes a cell's own value back still counts as the one row it found.
   */
  async applyChangeset(connectionString: string, statements: ChangesetStatement[], isolation?: unknown): Promise<number[]> {
    const level = isolationLevelSql(isolation);
    const conn = await this.acquire(connectionString);
    let clean = true;
    try {
      // Without SESSION or GLOBAL it applies to the next transaction only, so the pooled connection keeps its default.
      if (level) await conn.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
      await conn.query("START TRANSACTION");
      const counts: number[] = [];
      for (let i = 0; i < statements.length; i++) {
        const s = statements[i]!;
        let result: ResultSetHeader;
        try {
          [result] = await conn.execute<ResultSetHeader>({ sql: s.sql }, s.params as never[]);
        } catch (e) {
          throw new ChangesetStatementError(i, s, e);
        }
        const affected = Number(result.affectedRows ?? 0);
        checkAffected(statements, i, affected);
        counts.push(affected);
      }
      try {
        await conn.query("COMMIT");
      } catch (e) {
        throw new ChangesetStatementError(null, null, e);
      }
      return counts;
    } catch (e) {
      try { await conn.query("ROLLBACK"); } catch { clean = false; }
      throw e;
    } finally {
      if (clean) conn.release();
      else conn.destroy();
    }
  }

  /** The table editor's DDL, for this server's product and version (see `mysqlAlterTable`). */
  async planAlterTable(connectionString: string, base: TableModel, current: TableModel, diff: TableDiff, references: DbForeignKey[]): Promise<DdlPlan> {
    const info = await this.withCatalog(connectionString, async (_read, info) => info);
    return mysqlAlterTable(base, current, diff, { mariadb: info.mariadb, version: info.version, references });
  }

  /**
   * Run a DDL plan statement by statement, stopping at the first failure. MySQL commits each DDL
   * statement on its own, so what ran before a failure stays done: `DdlApplyError.applied` says
   * how many. Sent as plain queries, since not every DDL statement can be prepared.
   */
  async applyDdl(connectionString: string, plan: DdlPlan): Promise<void> {
    await this.withConnection(connectionString, async (conn) => {
      let applied = 0;
      for (let i = 0; i < plan.statements.length; i++) {
        const s = plan.statements[i]!;
        if (s.sql.startsWith("--")) continue;
        try {
          await conn.query({ sql: s.sql });
        } catch (e) {
          throw new DdlApplyError(ddlErrorMessage(e), s.sql, i, applied, e);
        }
        applied++;
      }
    });
  }

  /** How this server reads a statement, for splitting what a person typed the way it will. */
  private async statementsFor(connectionString: string, conn: PoolConnection, sqlText: string): Promise<string[]> {
    const info = await this.serverInfo(connectionString, this.reader(conn));
    return splitSqlStatements(sqlText, "mysql", { backslashEscapes: !info.noBackslashEscapes });
  }

  /**
   * Run SQL typed by a person, one statement at a time on one session, in
   * autocommit as the `mysql` client would. The session is closed afterwards
   * instead of pooled: a `USE`, a `SET NAMES latin1`, a user variable or a
   * `GET_LOCK()` would otherwise follow the connection into the next request.
   * A transaction left open is rolled back and reported rather than silently
   * lost with the session.
   */
  async runQuery(connectionString: string, sqlText: string): Promise<DbRunResult> {
    return this.withConnection(connectionString, async (conn) => {
      const statements = await this.statementsFor(connectionString, conn, sqlText);
      const start = performance.now();
      let last: { rows: unknown[][]; fields: FieldPacket[] } | null = null;
      let rowsAffected = 0;
      for (const statement of statements) {
        const answer = readAnswer(await this.runStatement(conn, statement));
        rowsAffected += answer.affected;
        if (answer.rowSets.length > 0) last = answer.rowSets[answer.rowSets.length - 1]!;
      }
      const executionTimeMs = Math.round(performance.now() - start);
      await this.refuseOpenTransaction(conn);
      if (!last) return { columns: [], rows: [], rowsAffected, changeType: "modify" as const, executionTimeMs };
      return {
        columns: describeFields(last.fields),
        rows: normalizeRows(last.rows, last.fields),
        rowsAffected,
        changeType: "select" as const,
        executionTimeMs,
      };
    }, { discard: true });
  }

  /**
   * The Query tab's session (see `DbQuerySession`) on a connection of its own, ended with the run,
   * so a `USE`, a user variable or a `GET_LOCK()` goes with it. `sql_select_limit` stops a SELECT, a
   * SHOW or a TABLE at the run's limit and one more, to know it was hit — an explicit LIMIT
   * outranks it, and it does not reach the statements inside a CALL, so every result is also cut
   * here. Stop is `KILL QUERY` from a second session, which a `SLEEP()` answers on MySQL by ending
   * *successfully*: only the caller knows the statement was stopped.
   */
  async openQuerySession(connectionString: string): Promise<DbQuerySession> {
    const job = await this.openJobConnection(connectionString);
    const { conn } = job;
    let info: MysqlServerInfo;
    try {
      // This session's own sql_mode, which decides how it reads a backslash in a string.
      info = await mysqlServerInfo(this.reader(conn));
    } catch (e) {
      this.endJobConnection(connectionString, job);
      throw e;
    }
    const splitOptions = { backslashEscapes: !info.noBackslashEscapes };
    let selectLimit = 0;
    let running = false;
    let ended = false;
    const runStatement = async (text: string, maxRows: number): Promise<DbStatementOutcome> => {
      running = true;
      let answer: ReturnType<typeof readAnswer>;
      try {
        if (selectLimit !== maxRows + 1) {
          await conn.query(`SET SESSION sql_select_limit = ${Math.trunc(maxRows) + 1}`);
          selectLimit = maxRows + 1;
        }
        answer = readAnswer(await this.runStatement(conn, text));
      } catch (e) {
        throw mysqlStatementError(e);
      } finally {
        running = false;
      }
      const resultSets = answer.rowSets.map(({ rows, fields }) => ({
        columns: describeFields(fields),
        rows: normalizeRows(rows.slice(0, maxRows), fields),
        truncated: rows.length > maxRows,
      }));
      const wrote = resultSets.length === 0 && WRITE_STATEMENT.test(sqlCode(text, "mysql", splitOptions));
      return { resultSets, ...(wrote ? { rowsAffected: answer.affected } : {}), notices: [] };
    };
    return {
      splitOptions,
      run: (text, maxRows) => this.inQueryStatement(text, () => runStatement(text, maxRows)),
      cancel: () => {
        if (running) void this.killQuery(connectionString, conn.threadId);
      },
      rollbackOpenTransaction: async () => {
        const [status] = await conn.query<ResultSetHeader>("DO 0");
        if ((Number(status.serverStatus) & SERVER_STATUS_IN_TRANS) === 0) return false;
        await conn.query("ROLLBACK");
        return true;
      },
      close: async () => {
        if (ended) return;
        ended = true;
        this.endJobConnection(connectionString, job);
      },
    };
  }

  /** One statement of a Query tab run, as this service runs it: just so here, refused unless a read below. */
  protected inQueryStatement<T>(_text: string, run: () => Promise<T>): Promise<T> {
    return run();
  }

  /** One statement a person wrote. */
  protected async runStatement(conn: PoolConnection, sql: string): Promise<QueryAnswer> {
    return await conn.query({ sql, rowsAsArray: true }) as QueryAnswer;
  }

  /** `DO 0` answers with the session's status flags, which say whether a transaction is still open. */
  private async refuseOpenTransaction(conn: PoolConnection): Promise<void> {
    const [status] = await conn.query<ResultSetHeader>("DO 0");
    if ((Number(status.serverStatus) & SERVER_STATUS_IN_TRANS) === 0) return;
    await conn.query("ROLLBACK");
    throw new Error("These statements started a transaction and did not end it, so it was rolled back. End it with COMMIT to keep the changes.");
  }

  /** The older records-shaped result the CLI prints. */
  async executeQuery(connectionString: string, sqlText: string): Promise<DbQueryResult> {
    const result = await this.runQuery(connectionString, sqlText);
    const { keys, records } = rowsToRecords(result.columns, result.rows);
    return { columns: keys, rows: records, rowsAffected: result.rowsAffected, changeType: result.changeType, executionTimeMs: result.executionTimeMs };
  }

  /**
   * A script file (`ppm db run`), statement by statement in autocommit, as
   * `mysql < file.sql` runs it. Not wrapped in a transaction: MySQL commits
   * implicitly at every DDL statement, so a wrapper would promise an
   * all-or-nothing it cannot keep, and the script's own `START TRANSACTION`
   * would end it early.
   */
  async executeScript(connectionString: string, scriptText: string): Promise<{ statementsRun: number; executionTimeMs: number }> {
    return this.withConnection(connectionString, async (conn) => {
      const statements = await this.statementsFor(connectionString, conn, scriptText);
      const start = performance.now();
      for (const statement of statements) await this.runStatement(conn, statement);
      await this.refuseOpenTransaction(conn);
      return { statementsRun: statements.length, executionTimeMs: Math.round(performance.now() - start) };
    }, { discard: true });
  }

  /** The older paged read behind `/data`, the CSV export and `ppm db data`. */
  async getTableData(
    connectionString: string, table: string, schema: string | undefined,
    page = 1, limit = 100, orderBy?: string, orderDir: "ASC" | "DESC" = "ASC",
  ): Promise<DbPagedData> {
    const target = mysqlDialect.qualify(table, schema ?? null);
    const order = orderBy ? ` ORDER BY ${mysqlDialect.quoteIdent(orderBy)} ${orderDir === "DESC" ? "DESC" : "ASC"}` : "";
    const offset = Math.max(0, (page - 1) * limit);
    return this.withConnection(connectionString, async (conn) => {
      const total = await this.count(conn, { sql: `SELECT COUNT(*) AS count FROM ${target}`, params: [] });
      const { columns, rows } = await this.select(conn, { sql: `SELECT * FROM ${target}${order} LIMIT ? OFFSET ?`, params: [limit, offset] });
      const { keys, records } = rowsToRecords(columns, rows);
      return { columns: keys, rows: records, total, page, limit };
    });
  }

  /** Close the pool for one connection string, if it has one, and the connections its jobs read or write on. */
  async close(connectionString: string): Promise<void> {
    for (const conn of this.jobConnections.get(connectionString) ?? []) conn.destroy();
    this.jobConnections.delete(connectionString);
    await this.disconnect(connectionString, "closed");
  }

  async closeAll(): Promise<void> {
    await Promise.all([...new Set([...this.pools.keys(), ...this.jobConnections.keys()])].map((key) => this.close(key)));
  }
}

/**
 * The same service for connections marked readonly, enforced by the server
 * rather than by reading the SQL. Every statement that reaches a user's table
 * — a grid page, a count, each statement typed in the editor — runs inside
 * its own `START TRANSACTION READ ONLY`, always rolled back:
 *
 * - a function that writes, called from a SELECT, is refused by the server
 *   (1792, SQLSTATE 25006), which the SQL check alone lets through;
 * - the transaction is opened explicitly each time because the session's
 *   read-only flag is itself a variable, and a *function* can clear it —
 *   measured on both servers, and on MariaDB the next statement then wrote.
 *   Every session still starts `SET SESSION TRANSACTION READ ONLY`, as a
 *   second layer for anything this file sends outside one;
 * - the SQL check still refuses `SET`, `COMMIT` and friends first, so the
 *   transaction cannot be ended or its flag cleared from the editor;
 * - `SELECT … INTO OUTFILE` runs inside a READ ONLY transaction on MariaDB, so
 *   the SQL check's `INTO` is what stops it.
 */
class ReadonlyMysqlService extends MysqlService {
  protected override sessionInit(): string[] {
    return [...super.sessionInit(), "SET SESSION TRANSACTION READ ONLY"];
  }

  private statementsOf(sqlText: string): void {
    if (!isReadOnlyQuery(sqlText, "mysql")) throw new ReadonlyViolationError();
  }

  private async readOnly<T>(conn: PoolConnection, fn: () => Promise<T>): Promise<T> {
    await conn.query("START TRANSACTION READ ONLY");
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      // The statement's own error is the one to report.
      await conn.query("ROLLBACK").catch(() => {});
      throw e;
    }
    await conn.query("ROLLBACK");
    return result;
  }

  protected override runStatement(conn: PoolConnection, sql: string): Promise<QueryAnswer> {
    return this.readOnly(conn, () => super.runStatement(conn, sql));
  }

  protected override select(conn: PoolConnection, stmt: DbStatement): Promise<DbRowSet> {
    return this.readOnly(conn, () => super.select(conn, stmt));
  }

  protected override count(conn: PoolConnection, stmt: DbStatement): Promise<number> {
    return this.readOnly(conn, () => super.count(conn, stmt));
  }

  override async runQuery(connectionString: string, sqlText: string): Promise<DbRunResult> {
    this.statementsOf(sqlText);
    return super.runQuery(connectionString, sqlText);
  }

  /** A Query tab statement that is not a plain read is refused before it is sent; a read runs READ ONLY (`runStatement`). */
  protected override async inQueryStatement<T>(text: string, run: () => Promise<T>): Promise<T> {
    if (!isReadOnlyQuery(text, "mysql")) {
      const refusal = new ReadonlyViolationError();
      throw new QueryStatementError(refusal.message, {}, refusal);
    }
    return run();
  }

  override async executeScript(connectionString: string, scriptText: string): Promise<{ statementsRun: number; executionTimeMs: number }> {
    this.statementsOf(scriptText);
    return super.executeScript(connectionString, scriptText);
  }

  override async applyChangeset(): Promise<number[]> {
    throw new ReadonlyViolationError("Connection is readonly — saving changes is disabled. Change this in PPM web UI.");
  }

  override async applyDdl(): Promise<void> {
    throw new ReadonlyViolationError(READONLY_STRUCTURE);
  }

  override async openWriteSession(): Promise<DbWriteSession> {
    throw new ReadonlyViolationError(READONLY_IMPORT);
  }
}

export const mysqlService = new MysqlService();
/** For connections marked readonly: its own pools, every session read-only. */
export const readonlyMysqlService = new ReadonlyMysqlService();
