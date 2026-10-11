import postgres from "postgres";
import { splitSqlStatements, sqlCode } from "../shared/split-sql-statements.ts";
import { toJsonRow } from "./database/db-values.ts";
import { nextFetchCount, rowBytes, type BatchLimits } from "./database/export-batch.ts";
import { pgGetStructure, pgListColumns, pgListForeignKeys, pgListObjects, pgServerVersion } from "./database/analyser-postgres.ts";
import { ChangesetStatementError, checkAffected, type ChangesetStatement } from "./database/changeset.ts";
import { QueryStatementError, READONLY_IMPORT, READONLY_STRUCTURE, ReadonlyViolationError } from "./database/db-errors.ts";
import { postgresAlterTable } from "./database/ddl/ddl-postgres.ts";
import { DdlApplyError, ddlErrorMessage, type DdlPlan } from "./database/ddl/ddl-types.ts";
import { keepArrayNulls } from "./database/postgres-array-nulls.ts";
import type { TableDiff } from "./database/ddl/table-diff.ts";
import type { TableModel } from "../shared/db-table-model.ts";
import { postgresConnectTarget } from "./database/postgres-connect-options.ts";
import { isolationLevelSql } from "./database/isolation-level.ts";
import type { IsolationLevel } from "../shared/db-connection-config.ts";
import { isReadOnlyQuery } from "./database/readonly-check.ts";
import type { ResultColumn } from "../shared/db-grid.ts";
import type { DbColumnRef, DbForeignKey, DbObjectList, DbObjectRef, DbTableStructure } from "../shared/db-structure.ts";
import { pgObjectSql } from "./database/object-sql-postgres.ts";
import type { DbCatalogTable, DbProbe, DbQuerySession, DbRowSet, DbRunResult, DbStatement, DbStatementOutcome, DbWriteSession, RunQueryOptions, StreamRowsOptions } from "../types/database.ts";
import { armQueryStop, QueryStoppedError, throwIfAborted } from "./database/query-stop.ts";
import { installTlsIdentityCheck } from "./database/tls-identity-check.ts";
import { connectionLogTarget as logTarget } from "./database/connection-endpoint.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("db");

// verify-full checks the certificate's name for a server named by IP address too.
installTlsIdentityCheck();

export interface PgTableInfo {
  name: string;
  schema: string;
  rowCount: number;
}

export interface PgColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue: string | null;
  /** An identity column, or a serial one: its default is the sequence's next value. */
  autoIncrement: boolean;
  fk: { table: string; column: string } | null;
}

export interface PgQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  changeType: "select" | "modify";
  executionTimeMs: number;
}

/** Auto-close idle connections after 5 minutes */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Seconds allowed for DNS + TCP + TLS + auth before postgres.js gives up.
 *  A healthy connect to a remote host over a VPN measures ~1s, so this only has to
 *  cover the *first* attempt on a cold network path — the retry below is what
 *  actually rescues that case, which is why this stays well under the library
 *  default of 30 (a longer value just makes a genuinely dead host take longer to
 *  report). */
const CONNECT_TIMEOUT_SEC = 15;

/** Extra attempts after a first attempt that failed before reaching the server. */
const CONNECT_RETRIES = 1;

/** Pause before re-attempting a connect-phase failure. */
const RETRY_DELAY_MS = 250;

/** Seconds to wait for a pool to drain before abandoning it, so evicting a wedged
 *  connection can never hang the caller. */
const END_TIMEOUT_SEC = 5;

/**
 * The TLS version of the connection `sql` holds, null in plain text: what shows whether
 * `sslmode=prefer` got TLS or fell back. A look-alike server with no `pg_stat_ssl` says nothing.
 */
async function postgresTls(sql: postgres.Sql): Promise<string | null | undefined> {
  try {
    const [row] = await sql`SELECT ssl, version FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()`;
    if (!row) return undefined;
    return row.ssl ? String(row.version ?? "TLS") : null;
  } catch {
    return undefined;
  }
}

/** Error codes that prove the statement never reached the server, so replaying it
 *  cannot double-apply a write. postgres.js holds a query until the startup
 *  handshake completes, so all of these are raised before any SQL is written to the
 *  socket. Ambiguous mid-query failures (CONNECTION_CLOSED, ECONNRESET) are
 *  deliberately excluded — retrying those could re-run an INSERT or UPDATE. */
const RETRYABLE_CONNECT_ERRORS = new Set([
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

interface CachedConn {
  sql: postgres.Sql;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Date and time values cross the driver as the text Postgres reads and prints.
 * postgres.js turns both directions into a JS `Date` by default, which is wrong
 * twice over for `timestamp without time zone`: a value is read in *this
 * server's* zone and sent on as UTC, so `2024-01-01 10:00:00` showed as `03:00Z`
 * on a UTC+7 host — and a parameter goes through `new Date(text)` the same way,
 * so filtering on or saving `10:00:00` compared with or wrote `03:00:00`.
 * Text now passes through untouched both ways and Postgres applies its own
 * rules; a `Date` object is still sent as its UTC instant.
 */
const DATE_TIME_OIDS = [1082, 1083, 1114, 1184, 1266]; // date, time, timestamp, timestamptz, timetz
const RAW_DATE_TIME_TYPES = {
  ppmRawDateTime: {
    to: 1184,
    from: DATE_TIME_OIDS,
    serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
    parse: (x: string) => x,
  },
};

/**
 * json and jsonb read as the text Postgres prints, which an export writes as it is — the way
 * MySQL's `jsonStrings` hands them over. Parsed by postgres.js, a JSON string reached a CSV file
 * bare (`"just text"` as `just text`, which no json column reads back), `"123"` came out a
 * number, JSON null an empty field and a number past 2^53 rounded.
 */
const JSON_OIDS = [114, 3802]; // json, jsonb

/** Names for the types a result column is most often of, as `format_type()` prints them. */
const PG_TYPE_NAMES: Record<number, string> = {
  16: "boolean", 17: "bytea", 18: "\"char\"", 19: "name", 20: "bigint", 21: "smallint", 23: "integer",
  25: "text", 26: "oid", 114: "json", 142: "xml", 650: "cidr", 700: "real", 701: "double precision",
  790: "money", 829: "macaddr", 869: "inet", 1042: "character", 1043: "character varying", 1082: "date",
  1083: "time without time zone", 1114: "timestamp without time zone", 1184: "timestamp with time zone",
  1186: "interval", 1266: "time with time zone", 1560: "bit", 1562: "bit varying", 1700: "numeric",
  2950: "uuid", 3802: "jsonb", 1000: "boolean[]", 1005: "smallint[]", 1007: "integer[]", 1016: "bigint[]",
  1009: "text[]", 1015: "character varying[]", 1021: "real[]", 1022: "double precision[]",
  1231: "numeric[]", 199: "json[]", 3807: "jsonb[]", 2951: "uuid[]", 1182: "date[]",
  1115: "timestamp without time zone[]", 1185: "timestamp with time zone[]",
};

/** Postgres SQLSTATE for a statement cancelled by `statement_timeout`. */
const QUERY_CANCELED = "57014";

/**
 * Awaits a postgres.js query, cancelling it on the server when `opts` says to stop: its time
 * limit passes, or its signal aborts. A cancelled statement fails with 57014 (as does one that
 * hit a `statement_timeout`), which is reported as the stop it was rather than as a failure.
 */
async function stoppable<T>(opts: RunQueryOptions | undefined, query: Promise<T> & { cancel(): unknown }): Promise<T> {
  if (!opts?.timeoutMs && !opts?.signal) return query;
  const stop = armQueryStop(opts, () => { query.cancel(); });
  try {
    return await query;
  } catch (e) {
    if ((e as { code?: string }).code === QUERY_CANCELED) throw new QueryStoppedError(stop.reason() ?? "timeout", opts.timeoutMs);
    throw e;
  } finally {
    stop.dispose();
  }
}

/**
 * `unsafe()` sends a statement with no parameters over the simple protocol,
 * which runs every statement in the string. `simple: false` keeps the grid on
 * the extended protocol whether or not it has parameters. postgres.js reads the
 * flag but its typings leave it out, hence a variable rather than an inline
 * literal (which the excess-property check would refuse).
 */
const EXTENDED_PROTOCOL = { prepare: false, simple: false };

/**
 * Parameters one statement may bind. The protocol counts them in 16 bits, but postgres.js refuses
 * 65 534 or more (`MAX_PARAMETERS_EXCEEDED`) before anything is sent.
 */
const PG_MAX_PARAMS = 65_533;

type PgResult = postgres.RowList<unknown[][]> & { command?: string; count?: number | null };

/** Rows one fetch of a Query tab result asks for, at most: the run's limit and one more, to know it was hit. */
const QUERY_FETCH_ROWS = 5_000;

/** ROLLBACK's warning when no transaction was open: "there is no transaction in progress". */
const NO_TRANSACTION_IN_PROGRESS = "25P01";

/** postgres.js and socket codes for a connection that is gone: nothing more can run on it. */
const LOST_CONNECTION = new Set(["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "ECONNRESET", "EPIPE", "ETIMEDOUT"]);

/** Commands whose count is the rows they wrote. */
const WRITE_COMMAND = /^(INSERT|UPDATE|DELETE|MERGE|COPY)$/;

/**
 * `COPY … FROM STDIN` and `COPY … TO STDOUT` hand the rows to the client, which has to send or take
 * them: postgres.js answers the first with a stream nobody writes to, and the session then waits
 * for rows forever — every later statement on it hung. Refused before it is sent.
 */
function isCopyThroughClient(statement: string): boolean {
  const code = sqlCode(statement, "postgres");
  return /^\s*copy\b/i.test(code) && /\b(stdin|stdout)\b/i.test(code);
}

/**
 * A failed Query tab statement, carrying where Postgres says the error is in `text`, the statement
 * sent. Postgres counts characters; JS counts UTF-16 units, two for a character past U+FFFF.
 */
function pgStatementError(e: unknown, text?: string): QueryStatementError {
  const err = e as { message?: unknown; position?: unknown; code?: unknown } | null;
  const position = Number(err?.position);
  return new QueryStatementError(
    typeof err?.message === "string" ? err.message : String(e),
    Number.isInteger(position) && position > 0 ? { position: text === undefined ? position : Array.from(text).slice(0, position - 1).join("").length + 1 } : {},
    e,
    typeof err?.code === "string" && LOST_CONNECTION.has(err.code),
  );
}

/** A notice as Messages shows it: Postgres's level, then its text. */
function noticeText(notice: postgres.Notice): string {
  return notice.severity ? `${notice.severity}: ${notice.message ?? ""}` : String(notice.message ?? "");
}

class PostgresService {
  protected cache = new Map<string, CachedConn>();
  /** The clients an export reads on or an import writes on, by connection string, which `close()` ends with the pool. */
  private jobClients = new Map<string, Set<postgres.Sql>>();

  /** Run-time parameters every session of this service's pools starts with. */
  protected sessionParams(): Record<string, string> | undefined {
    return undefined;
  }

  /** Get or create a cached connection */
  protected connect(connectionString: string): postgres.Sql {
    const cached = this.cache.get(connectionString);
    if (cached) {
      clearTimeout(cached.timer);
      cached.timer = setTimeout(() => this.disconnect(connectionString, "idle"), IDLE_TIMEOUT_MS);
      return cached.sql;
    }
    const sql = this.client(connectionString, 3);
    const timer = setTimeout(() => this.disconnect(connectionString, "idle"), IDLE_TIMEOUT_MS);
    this.cache.set(connectionString, { sql, timer });
    log.info(`postgres pool opened ${logTarget(connectionString)}${this instanceof ReadonlyPostgresService ? " readonly" : ""}`);
    return sql;
  }

  /** A client for `connectionString`, given what postgres.js cannot read from the URL itself. */
  /**
   * `untimed`: never closed by postgres.js for being idle or old — a connection holding a cursor
   * waits between two fetches for as long as the download does, and closing it there ends the read.
   */
  private client(connectionString: string, max: number, untimed = false, onnotice?: (notice: postgres.Notice) => void): postgres.Sql {
    const target = postgresConnectTarget(connectionString);
    const sql = postgres(target.url, {
      max,
      idle_timeout: untimed ? 0 : 60,
      ...(untimed ? { max_lifetime: 0 } : {}),
      ...(onnotice ? { onnotice } : {}),
      connect_timeout: CONNECT_TIMEOUT_SEC,
      // Only when the URL says: an `ssl` key that is present wins over the URL, even set to undefined.
      ...("ssl" in target ? { ssl: target.ssl as any } : {}),
      ...(target.host ? { host: target.host } : {}),
      ...(target.socket ? { socket: target.socket } : {}),
      types: RAW_DATE_TIME_TYPES as any,
      connection: this.sessionParams() as any,
    });
    // Before any connection opens, which is when postgres.js registers its array parsers.
    keepArrayNulls(sql.options.parsers);
    return sql;
  }

  /** Close and remove from cache. `reason` is for the log; a pool dropped to retry its connect has none. */
  protected async disconnect(connectionString: string, reason?: string) {
    const cached = this.cache.get(connectionString);
    if (!cached) return;
    if (reason) log.info(`postgres pool closed ${logTarget(connectionString)}${this instanceof ReadonlyPostgresService ? " readonly" : ""}: ${reason}`);
    clearTimeout(cached.timer);
    // Drop the cache entry first: end() on a pool whose socket never came up can
    // stall for the full drain timeout, and callers must not see it again meanwhile.
    this.cache.delete(connectionString);
    try { await cached.sql.end({ timeout: END_TIMEOUT_SEC }); } catch { /* already closed */ }
  }

  /** True when the error happened before the query was written to the socket. */
  private isRetryableConnectError(e: unknown): boolean {
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === "string" && RETRYABLE_CONNECT_ERRORS.has(code);
  }

  /** Run an operation against the cached pool, retrying if the connection never
   *  got established. The first connect over a cold VPN path can burn ~20s on TCP
   *  SYN retransmits and then fail outright, while an immediate second attempt
   *  succeeds in about a second — without this, that first failure surfaces to the
   *  user as a hard error. Only connect-phase failures are replayed, so a retried
   *  write cannot be applied twice. */
  protected async withConnection<T>(
    connectionString: string,
    fn: (sql: postgres.Sql) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const sql = this.connect(connectionString);
      try {
        return await fn(sql);
      } catch (e) {
        if (attempt >= CONNECT_RETRIES || !this.isRetryableConnectError(e)) throw e;
        log.warn(`postgres connect to ${logTarget(connectionString)} failed (${(e as { code?: unknown }).code}), retrying in ${RETRY_DELAY_MS}ms`);
        // Discard the pool that failed to connect so the retry starts clean.
        await this.disconnect(connectionString);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  /** Test connection */
  async testConnection(connectionString: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.withConnection(connectionString, (sql) => sql`SELECT 1`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * One connection, closed again: the server's version and the databases the login can open.
   * Nothing is cached, so a login typed only to be tested is not kept by a pool.
   */
  async probe(connectionString: string): Promise<DbProbe> {
    const sql = this.client(connectionString, 1);
    try {
      const [row] = await sql`SELECT current_setting('server_version') AS version`;
      const dbs = await sql`
        SELECT datname FROM pg_catalog.pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname`;
      // `17.2 (Debian 17.2-1.pgdg120+1)`: the build is in the parenthesis.
      const version = String(row?.version ?? "").split(" ")[0];
      return { version: `PostgreSQL ${version}`, databases: dbs.map((r) => String(r.datname)), tls: await postgresTls(sql) };
    } finally {
      // Not awaited: end() on a client whose socket never came up waits out its whole timeout.
      sql.end({ timeout: END_TIMEOUT_SEC }).catch(() => {});
    }
  }

  /** The databases the login can open, read on the connection's own pool; as `probe` lists them. */
  async listDatabases(connectionString: string): Promise<string[]> {
    const rows = await this.withConnection(connectionString, (sql) => sql`
      SELECT datname FROM pg_catalog.pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname`);
    return rows.map((r) => String(r.datname));
  }

  /** List all user tables with row counts */
  async getTables(connectionString: string): Promise<PgTableInfo[]> {
    const tables = await this.withConnection(connectionString, (sql) => sql`
      SELECT t.schemaname as schema, t.tablename as name,
             COALESCE(s.n_live_tup, 0)::int as row_count
      FROM pg_tables t
      LEFT JOIN pg_stat_user_tables s ON t.schemaname = s.schemaname AND t.tablename = s.relname
      WHERE t.schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY t.schemaname, t.tablename
    `);
    return tables.map((t) => ({
      name: t.name as string, schema: t.schema as string, rowCount: t.row_count as number,
    }));
  }

  /** Get column schema for a table (with FK metadata) */
  async getTableSchema(connectionString: string, table: string, schema = "public"): Promise<PgColumnInfo[]> {
    const { cols, fkRows } = await this.withConnection(connectionString, async (sql) => {
      const cols = await sql`
        SELECT c.column_name as name, c.data_type as type,
               c.is_nullable = 'YES' as nullable, c.column_default as default_value,
               COALESCE(tc.constraint_type = 'PRIMARY KEY', false) as pk,
               c.is_identity = 'YES' OR COALESCE(c.column_default LIKE 'nextval(%', false) as auto_increment
        FROM information_schema.columns c
        LEFT JOIN information_schema.key_column_usage kcu
          ON c.table_schema = kcu.table_schema AND c.table_name = kcu.table_name AND c.column_name = kcu.column_name
        LEFT JOIN information_schema.table_constraints tc
          ON kcu.constraint_name = tc.constraint_name AND tc.constraint_type = 'PRIMARY KEY'
        WHERE c.table_schema = ${schema} AND c.table_name = ${table}
        ORDER BY c.ordinal_position
      `;

      // Query FK references
      const fkRows = await sql`
        SELECT kcu.column_name as from_col,
               ccu.table_name as ref_table,
               ccu.column_name as ref_col
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = ${schema} AND tc.table_name = ${table}
      `;
      return { cols, fkRows };
    });

    const fkMap = new Map<string, { table: string; column: string }>();
    for (const fk of fkRows) {
      fkMap.set(fk.from_col as string, { table: fk.ref_table as string, column: fk.ref_col as string });
    }

    return cols.map((c) => ({
      name: c.name as string,
      type: c.type as string,
      nullable: c.nullable === true || c.nullable === "true" || c.nullable === "t",
      pk: c.pk === true || c.pk === "true" || c.pk === "t",
      defaultValue: c.default_value as string | null,
      autoIncrement: c.auto_increment === true || c.auto_increment === "true" || c.auto_increment === "t",
      fk: fkMap.get(c.name as string) ?? null,
    }));
  }

  /** Get paginated rows from a table */
  async getTableData(
    connectionString: string, table: string, schema = "public",
    page = 1, limit = 100, orderBy?: string, orderDir: "ASC" | "DESC" = "ASC",
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number }> {
    const offset = (page - 1) * limit;
    const { rows, total } = await this.withConnection(connectionString, async (sql) => {
      const fullTable = sql(`${schema}.${table}`);

      const [countRow] = await sql`SELECT COUNT(*)::int as cnt FROM ${fullTable}`;
      const total = (countRow?.cnt as number) ?? 0;

      let rows: postgres.RowList<postgres.Row[]>;
      if (orderBy) {
        const orderCol = sql(orderBy);
        rows = orderDir === "DESC"
          ? await sql`SELECT * FROM ${fullTable} ORDER BY ${orderCol} DESC LIMIT ${limit} OFFSET ${offset}`
          : await sql`SELECT * FROM ${fullTable} ORDER BY ${orderCol} ASC LIMIT ${limit} OFFSET ${offset}`;
      } else {
        rows = await sql`SELECT * FROM ${fullTable} LIMIT ${limit} OFFSET ${offset}`;
      }
      return { rows, total };
    });

    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return { columns, rows: rows as unknown as Record<string, unknown>[], total, page, limit };
  }

  /** Execute arbitrary SQL */
  async executeQuery(connectionString: string, sqlText: string): Promise<PgQueryResult> {
    const trimmed = sqlText.trim();
    const upper = trimmed.toUpperCase();

    // postgres.js blocks raw BEGIN/COMMIT/ROLLBACK with connection pooling (max > 1).
    // Detect transaction control and route through executeScript which uses sql.begin().
    const txPattern = /^(BEGIN|COMMIT|ROLLBACK|END)(;|\s|$)/i;
    const statements = splitSqlStatements(trimmed);
    const hasTxControl = statements.some((s) => txPattern.test(s.trim()));
    if (hasTxControl) {
      const realStatements = statements.filter((s) => !txPattern.test(s.trim()));
      if (realStatements.length === 0) {
        // Only transaction control statements (e.g. bare "BEGIN;") — no-op
        return { columns: [], rows: [], rowsAffected: 0, changeType: "modify", executionTimeMs: 0 };
      }
      // Multi-statement block with tx control — run as transaction via sql.begin()
      const start = performance.now();
      const result = await this.executeScript(connectionString, trimmed);
      return { columns: [], rows: [], rowsAffected: result.statementsRun, changeType: "modify", executionTimeMs: result.executionTimeMs };
    }

    const isSelect = upper.startsWith("SELECT") || upper.startsWith("WITH") ||
      upper.startsWith("EXPLAIN") || upper.startsWith("SHOW") || upper.startsWith("\\D");

    return this.withConnection(connectionString, async (sql) => {
      const start = performance.now();
      if (isSelect) {
        const rows = await sql.unsafe(sqlText);
        const executionTimeMs = Math.round(performance.now() - start);
        const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
        return { columns, rows: rows as unknown as Record<string, unknown>[], rowsAffected: 0, changeType: "select" as const, executionTimeMs };
      }

      const result = await sql.unsafe(sqlText);
      const executionTimeMs = Math.round(performance.now() - start);
      return { columns: [], rows: [], rowsAffected: result.count ?? 0, changeType: "modify" as const, executionTimeMs };
    });
  }

  /** Execute multi-statement SQL script inside a transaction via sql.begin().
   *  Strips user-supplied BEGIN/COMMIT/ROLLBACK since sql.begin() manages the transaction. */
  async executeScript(connectionString: string, scriptText: string): Promise<{ statementsRun: number; executionTimeMs: number }> {
    const txControl = /^(BEGIN|COMMIT|ROLLBACK|END)(;|\s|$)/i;
    const statements = splitSqlStatements(scriptText).filter((s) => !txControl.test(s));
    if (statements.length === 0) return { statementsRun: 0, executionTimeMs: 0 };

    return this.withConnection(connectionString, async (sql) => {
      const start = performance.now();
      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
      });
      return { statementsRun: statements.length, executionTimeMs: Math.round(performance.now() - start) };
    });
  }

  /** Update a single cell value */
  async updateCell(
    connectionString: string, table: string, schema = "public",
    pkColumn: string, pkValue: unknown, column: string, value: unknown,
  ): Promise<void> {
    await this.withConnection(connectionString, (sql) => sql.unsafe(
      `UPDATE "${schema}"."${table}" SET "${column}" = $1 WHERE "${pkColumn}" = $2`,
      [value as never, pkValue as never],
    ));
  }

  /** Delete a row by primary key */
  async deleteRow(
    connectionString: string, table: string, schema = "public",
    pkColumn: string, pkValue: unknown,
  ): Promise<void> {
    await this.withConnection(connectionString, (sql) => sql.unsafe(
      `DELETE FROM "${schema}"."${table}" WHERE "${pkColumn}" = $1`,
      [pkValue as never],
    ));
  }

  /**
   * Columns of a table, view, materialized view or foreign table in attnum
   * order, with the primary key's columns in key order; null when it does not exist.
   */
  async describeTable(connectionString: string, table: string, schema = "public"): Promise<DbCatalogTable | null> {
    const rows = await this.withConnection(connectionString, (sql) => sql`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
             array_position(pk.conkey, a.attnum) AS pk
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
      WHERE n.nspname = ${schema} AND c.relname = ${table}
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `);
    if (rows.length === 0) return null;
    const rowKey = rows.filter((r) => r.pk != null).sort((a, b) => Number(a.pk) - Number(b.pk)).map((r) => r.name as string);
    return { columns: rows.map((r) => ({ name: r.name as string, type: r.type as string })), rowKey, rowKeyIsRowid: false, rowidAliases: [] };
  }

  /** `server_version_num` per connection string, read once: the analyser's catalog queries depend on it. */
  private versions = new Map<string, number>();

  private async serverVersion(connectionString: string, sql: postgres.Sql): Promise<number> {
    let v = this.versions.get(connectionString);
    if (v === undefined) {
      v = await pgServerVersion(sql);
      this.versions.set(connectionString, v);
    }
    return v;
  }

  async listObjects(connectionString: string): Promise<DbObjectList> {
    return this.withConnection(connectionString, async (sql) => pgListObjects(sql, await this.serverVersion(connectionString, sql)));
  }

  async listColumns(connectionString: string): Promise<DbColumnRef[]> {
    return this.withConnection(connectionString, (sql) => pgListColumns(sql));
  }

  async getStructure(connectionString: string, table: string, schema = "public"): Promise<DbTableStructure | null> {
    return this.withConnection(connectionString, async (sql) => pgGetStructure(sql, await this.serverVersion(connectionString, sql), schema, table));
  }

  async listForeignKeys(connectionString: string): Promise<DbForeignKey[]> {
    return this.withConnection(connectionString, async (sql) => pgListForeignKeys(sql, await this.serverVersion(connectionString, sql)));
  }

  async getObjectSql(connectionString: string, obj: DbObjectRef): Promise<string | null> {
    return this.withConnection(connectionString, async (sql) => pgObjectSql(sql, await this.serverVersion(connectionString, sql), obj));
  }

  /**
   * Run a changeset's statements in one transaction, in order, and return how
   * many rows each hit. They are sent without waiting for one another, so
   * postgres.js pipelines them: a save of a thousand rows over a slow link is
   * about one round trip rather than a thousand. Rows are counted as the
   * answers arrive; the first failure or miscount rolls the whole thing back.
   */
  async applyChangeset(connectionString: string, statements: ChangesetStatement[], isolation?: unknown): Promise<number[]> {
    const level = isolationLevelSql(isolation);
    return this.withConnection(connectionString, (sql) => this.runChangeset(sql, statements, level));
  }

  protected async runChangeset(sql: postgres.Sql, statements: ChangesetStatement[], isolation: IsolationLevel | null = null): Promise<number[]> {
    let failed: ChangesetStatementError | null = null;
    let ran = false;
    // The connection's Default isolation level, when it has one; the server's own otherwise.
    const begin = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      isolation ? sql.begin(`isolation level ${isolation.toLowerCase()}`, fn) : sql.begin(fn);
    try {
      return await begin(async (tx) => {
        const pending = statements.map((s) => tx.unsafe(s.sql, s.params as never[], EXTENDED_PROTOCOL));
        // Once one fails every later one is refused too (25P02); only the first says why.
        for (const p of pending) p.catch(() => {});
        const counts: number[] = [];
        for (let i = 0; i < pending.length; i++) {
          let result: PgResult;
          try {
            result = await pending[i]! as unknown as PgResult;
          } catch (e) {
            throw (failed = new ChangesetStatementError(i, statements[i]!, e));
          }
          const affected = Number(result.count ?? 0);
          try { checkAffected(statements, i, affected); } catch (e) { throw (failed = e as ChangesetStatementError); }
          counts.push(affected);
        }
        ran = true;
        return counts;
      });
    } catch (e) {
      if (failed) throw failed;
      // Every statement went through, so what failed is the COMMIT: a deferred constraint.
      if (ran) throw new ChangesetStatementError(null, null, e);
      // BEGIN never got through (a connect failure withConnection may retry).
      throw e;
    }
  }

  /** The table editor's DDL, for this server's version (see `postgresAlterTable`). */
  async planAlterTable(connectionString: string, base: TableModel, current: TableModel, diff: TableDiff, references: DbForeignKey[]): Promise<DdlPlan> {
    return this.withConnection(connectionString, async (sql) => postgresAlterTable(base, current, diff, {
      version: await this.serverVersion(connectionString, sql), references,
    }));
  }

  /**
   * Run a DDL plan in one transaction, which Postgres allows for DDL: a failure anywhere leaves
   * nothing of it applied. One statement at a time, since each may need the one before it.
   */
  async applyDdl(connectionString: string, plan: DdlPlan): Promise<void> {
    await this.withConnection(connectionString, async (sql) => {
      let ran = false;
      try {
        await sql.begin(async (tx) => {
          for (let i = 0; i < plan.statements.length; i++) {
            const s = plan.statements[i]!;
            if (s.sql.startsWith("--")) continue;
            try {
              await tx.unsafe(s.sql, [], EXTENDED_PROTOCOL);
            } catch (e) {
              throw new DdlApplyError(ddlErrorMessage(e), s.sql, i, 0, e);
            }
          }
          ran = true;
        });
      } catch (e) {
        if (e instanceof DdlApplyError) throw e;
        // Every statement went through, so what failed is the COMMIT: a deferred constraint.
        if (ran) throw new DdlApplyError(ddlErrorMessage(e), "COMMIT", -1, 0, e);
        // BEGIN never got through (a connect failure withConnection may retry).
        throw e;
      }
    });
  }

  /** Names for result-column type OIDs, looked up once per connection for the uncommon ones. */
  private typeNames = new Map<string, Map<number, string>>();

  private async resolveTypeNames(connectionString: string, sql: postgres.Sql | postgres.TransactionSql, oids: number[]): Promise<Map<number, string>> {
    let known = this.typeNames.get(connectionString);
    if (!known) { known = new Map(); this.typeNames.set(connectionString, known); }
    const missing = [...new Set(oids)].filter((o) => Number.isInteger(o) && o > 0 && !(o in PG_TYPE_NAMES) && !known!.has(o));
    if (missing.length > 0) {
      try {
        // OIDs come from the wire protocol, not from a user, and are checked to be integers above.
        const rows = await sql.unsafe(`SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_catalog.pg_type WHERE oid IN (${missing.join(", ")})`);
        for (const r of rows) known.set(Number(r.oid), String(r.name));
      } catch { /* a name is cosmetic; fall back to the number */ }
    }
    return known;
  }

  protected async describeResultColumns(connectionString: string, sql: postgres.Sql | postgres.TransactionSql, cols: readonly { name: string; type: number }[] | undefined): Promise<ResultColumn[]> {
    if (!cols) return [];
    const known = await this.resolveTypeNames(connectionString, sql, cols.map((c) => c.type));
    return cols.map((c) => ({ name: c.name, type: PG_TYPE_NAMES[c.type] ?? known.get(c.type) ?? `oid ${c.type}` }));
  }

  /**
   * Run one grid SELECT. The extended protocol is forced even when there are no
   * parameters: Postgres then refuses a second statement outright ("cannot
   * insert multiple commands into a prepared statement"), which is what keeps a
   * user-written filter condition inside the one SELECT it was put in.
   */
  async selectRows(connectionString: string, stmt: DbStatement): Promise<DbRowSet> {
    return this.withConnection(connectionString, async (sql) => {
      const result = await sql.unsafe(stmt.sql, stmt.params as never[], EXTENDED_PROTOCOL).values() as unknown as PgResult;
      return {
        columns: await this.describeResultColumns(connectionString, sql, result.columns),
        rows: Array.from(result, (row) => toJsonRow(row as unknown[])),
      };
    });
  }

  /**
   * Export's read, through a cursor on a client of its own: one connection, ended when the rows
   * are, that a download as slow as the browser's never takes from the pool. `max: 1` is also what
   * lets a plain `BEGIN` through postgres.js; nothing is committed, as ending the client rolls the
   * transaction back. Only the `BEGIN` is retried: nothing has been read by then.
   *
   * A `DECLARE`d cursor rather than postgres.js's own, which fetches a fixed number of rows each
   * time: `FETCH` takes a count per call, so a table of wide rows is read a few at a time (see
   * `nextFetchCount`). `cursor_tuple_fraction = 1` plans for reading every row, as an export does,
   * where a cursor is otherwise planned for its first tenth.
   *
   * The statement runs on the FETCHes — the first one may sort the whole table — so `signal`
   * cancels the FETCH in flight, which a closed connection would not: the server would go on
   * sorting until it had rows to send.
   */
  async *streamRows(connectionString: string, stmt: DbStatement, limits: BatchLimits, opts: StreamRowsOptions = {}): AsyncGenerator<unknown[][]> {
    let { onColumns } = opts;
    const { signal } = opts;
    signal?.throwIfAborted();
    const sql = await this.openJobClient(connectionString, "BEGIN READ ONLY");
    // Once connected: postgres.js has built its array parsers from these by then, so a json[] is
    // still read into values, which is what the writers expect of an array.
    for (const oid of JSON_OIDS) sql.options.parsers[oid] = (text: string) => text;
    try {
      await sql.unsafe("SET LOCAL cursor_tuple_fraction = 1");
      await sql.unsafe(`DECLARE ppm_export NO SCROLL CURSOR FOR ${stmt.sql}`, stmt.params as never[], EXTENDED_PROTOCOL);
      for (let count = 1; ;) {
        signal?.throwIfAborted();
        const fetching = sql.unsafe(`FETCH FORWARD ${count} FROM ppm_export`, [], EXTENDED_PROTOCOL);
        const cancel = (): void => { fetching.cancel(); };
        signal?.addEventListener("abort", cancel, { once: true });
        let rows: PgResult;
        try {
          rows = await fetching.values() as unknown as PgResult;
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
        if (onColumns) {
          onColumns(await this.describeResultColumns(connectionString, sql, rows.columns));
          onColumns = undefined;
        }
        if (rows.length) yield Array.from(rows) as unknown[][];
        if (rows.length < count) return;
        let widest = 0;
        for (const row of rows) widest = Math.max(widest, rowBytes(row));
        count = nextFetchCount(count, widest, limits);
      }
    } finally {
      await this.endJobClient(connectionString, sql);
    }
  }

  /**
   * Import's writer (see `DbWriteSession`): a client of its own in a transaction, which ending the
   * client without a COMMIT rolls back. One statement at a time, over the extended protocol.
   */
  async openWriteSession(connectionString: string): Promise<DbWriteSession> {
    const sql = await this.openJobClient(connectionString, "BEGIN");
    let running: { cancel(): unknown } | null = null;
    let ended = false;
    const send = async (text: string, params: unknown[]): Promise<number> => {
      if (ended) throw new Error("The import's connection is closed");
      const query = sql.unsafe(text, params as never[], EXTENDED_PROTOCOL);
      running = query;
      try {
        return Number(((await query) as unknown as PgResult).count ?? 0);
      } finally {
        running = null;
      }
    };
    const end = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      await this.endJobClient(connectionString, sql);
    };
    return {
      maxParams: PG_MAX_PARAMS,
      ddl: async (text) => { await send(text, []); },
      run: (stmt) => send(stmt.sql, stmt.params),
      commit: async () => {
        await send("COMMIT", []);
        await end();
      },
      close: end,
      cancel: () => { void (running as { cancel(): unknown } | null)?.cancel(); },
    };
  }

  /**
   * A client of its own for a job, `begin` run on it: `max: 1`, which is also what lets a plain
   * `BEGIN` through postgres.js, and never closed for being idle. Only `begin` is retried — nothing
   * has been read or written by then. `close()` ends it with the pool.
   */
  private async openJobClient(connectionString: string, begin: string, onnotice?: (notice: postgres.Notice) => void): Promise<postgres.Sql> {
    for (let attempt = 0; ; attempt++) {
      const sql = this.client(connectionString, 1, true, onnotice);
      try {
        await sql.unsafe(begin);
        this.jobClients.set(connectionString, (this.jobClients.get(connectionString) ?? new Set<postgres.Sql>()).add(sql));
        return sql;
      } catch (e) {
        sql.end({ timeout: END_TIMEOUT_SEC }).catch(() => {});
        if (attempt >= CONNECT_RETRIES || !this.isRetryableConnectError(e)) throw e;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  /** Ends a job's client: the server rolls back a transaction it left open. */
  private async endJobClient(connectionString: string, sql: postgres.Sql): Promise<void> {
    const clients = this.jobClients.get(connectionString);
    if (clients?.delete(sql) && !clients.size) this.jobClients.delete(connectionString);
    await sql.end({ timeout: END_TIMEOUT_SEC }).catch(() => {});
  }

  /** COUNT(*) under a statement_timeout; null when the timeout cancelled it. */
  async countRows(connectionString: string, stmt: DbStatement, timeoutMs: number): Promise<number | null> {
    try {
      return await this.withConnection(connectionString, (sql) => sql.begin(async (tx) => {
        // SET LOCAL ends with the transaction, so the timeout never leaks into
        // the next query that borrows this pooled connection.
        await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.round(timeoutMs))}`);
        const [row] = await tx.unsafe(stmt.sql, stmt.params as never[], EXTENDED_PROTOCOL);
        return Number((row as { count?: unknown } | undefined)?.count ?? 0);
      }));
    } catch (e) {
      if ((e as { code?: string }).code === QUERY_CANCELED) return null;
      throw e;
    }
  }

  /** `pg_class.reltuples`: kept by ANALYZE/autovacuum, -1 when never analyzed. */
  async estimateRows(connectionString: string, table: string, schema = "public"): Promise<number | null> {
    const rows = await this.withConnection(connectionString, (sql) => sql`
      SELECT c.reltuples::float8 AS estimate
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = ${table}
    `);
    const estimate = Number(rows[0]?.estimate);
    return Number.isFinite(estimate) && estimate >= 0 ? Math.round(estimate) : null;
  }

  /**
   * Run SQL typed by the user. What came back decides the shape, not the first
   * keyword: `INSERT … RETURNING` has rows, and a script whose last statement
   * is a SELECT shows that SELECT. Transaction control keeps going through
   * `executeScript`, like `executeQuery` does.
   */
  async runQuery(connectionString: string, sqlText: string, opts?: RunQueryOptions): Promise<DbRunResult> {
    throwIfAborted(opts);
    const txPattern = /^(BEGIN|COMMIT|ROLLBACK|END)(;|\s|$)/i;
    const statements = splitSqlStatements(sqlText.trim());
    if (statements.some((st) => txPattern.test(st.trim()))) {
      const result = await this.executeQuery(connectionString, sqlText);
      return { columns: [], rows: [], rowsAffected: result.rowsAffected, changeType: "modify", executionTimeMs: result.executionTimeMs };
    }

    return this.withConnection(connectionString, async (sql) => {
      const start = performance.now();
      const query = sql.unsafe(sqlText).values();
      const raw = await stoppable(opts, query) as unknown as PgResult | PgResult[];
      const executionTimeMs = Math.round(performance.now() - start);
      // One statement answers with a Result; several answer with a plain array of them.
      const results: PgResult[] = (raw as PgResult).command !== undefined ? [raw as PgResult] : raw as PgResult[];
      const withRows = [...results].reverse().find((r) => r.columns);
      const rowsAffected = results.reduce((n, r) => n + (r.columns ? 0 : Number(r.count ?? 0)), 0);
      if (withRows) {
        return {
          columns: await this.describeResultColumns(connectionString, sql, withRows.columns),
          rows: Array.from(withRows, (row) => toJsonRow(row as unknown[])),
          rowsAffected,
          changeType: "select" as const,
          executionTimeMs,
        };
      }
      return { columns: [], rows: [], rowsAffected, changeType: "modify" as const, executionTimeMs };
    });
  }

  /**
   * The Query tab's session (see `DbQuerySession`): a client of its own for the run, so a SET, a
   * temporary table or a BEGIN holds from one statement to the next, and nothing of it reaches the
   * pool. Each statement goes alone over the extended protocol — a second statement inside one is
   * refused, not run — through a portal read at most `maxRows + 1` rows at a time: closing it at
   * the limit stops a SELECT from producing the rest, while a write with RETURNING has already run
   * whole by then. Type names come from the pool, so no catalog read lands in the script's own
   * transaction.
   */
  async openQuerySession(connectionString: string): Promise<DbQuerySession> {
    let heard: postgres.Notice[] = [];
    const sql = await this.openJobClient(connectionString, "SELECT 1", (notice) => { heard.push(notice); });
    let running: { cancel(): unknown } | null = null;
    const runStatement = async (text: string, maxRows: number): Promise<DbStatementOutcome> => {
      if (isCopyThroughClient(text)) {
        throw new QueryStatementError("COPY … FROM STDIN and COPY … TO STDOUT need a client that sends or takes the rows: use Import or Export instead");
      }
      const notices: postgres.Notice[] = [];
      heard = notices;
      const rows: unknown[][] = [];
      let truncated = false;
      const query = sql.unsafe(text, [], EXTENDED_PROTOCOL).values();
      running = query;
      const take = (batch: readonly unknown[]) => {
        for (const row of batch) {
          if (rows.length === maxRows) {
            truncated = true;
            return sql.CLOSE;
          }
          rows.push(toJsonRow(row as unknown[]));
        }
      };
      let final: { command?: string | null; count?: number | null } | undefined;
      try {
        final = await query.cursor(Math.min(maxRows + 1, QUERY_FETCH_ROWS), take) as { command?: string | null; count?: number | null } | undefined;
        // postgres.js hands a cursor its last fetch only when the command tag counts rows. EXPLAIN,
        // SHOW and CALL end on a bare tag: their last rows are what the query resolves to instead.
        if (!final?.count && Array.isArray(final)) take(final);
      } catch (e) {
        throw pgStatementError(e, text);
      } finally {
        running = null;
      }
      // The columns of the statement's RowDescription, which postgres.js keeps on the query: a
      // result of no rows has no batch to read them from. A statement that returns no rows at all
      // (CREATE, SET, an INSERT without RETURNING) leaves the list empty.
      const columns = (query as unknown as { statement?: { columns?: { name: string; type: number }[] | null } }).statement?.columns;
      const command = final?.command ?? undefined;
      const count = typeof final?.count === "number" ? final.count : undefined;
      return {
        resultSets: columns?.length ? [{ columns: await this.describeResultColumns(connectionString, this.connect(connectionString), columns), rows, truncated }] : [],
        ...(command && WRITE_COMMAND.test(command) && count !== undefined ? { rowsAffected: count } : {}),
        ...(command ? { command } : {}),
        notices: notices.map(noticeText),
      };
    };
    return {
      splitOptions: {},
      run: (text, maxRows) => this.inQueryStatement(sql, text, () => runStatement(text, maxRows)),
      cancel: () => { void running?.cancel(); },
      rollbackOpenTransaction: async () => {
        const notices: postgres.Notice[] = [];
        heard = notices;
        await sql.unsafe("ROLLBACK");
        return !notices.some((n) => n.code === NO_TRANSACTION_IN_PROGRESS);
      },
      close: () => this.endJobClient(connectionString, sql),
    };
  }

  /** One statement of a Query tab run, as this service runs it: just so here, read-only below. */
  protected inQueryStatement<T>(_sql: postgres.Sql, _text: string, run: () => Promise<T>): Promise<T> {
    return run();
  }

  /** Close all cached connections */
  /** Close the pool for one connection string, if it has one. */
  async close(connectionString: string): Promise<void> {
    const exports = [...(this.jobClients.get(connectionString) ?? [])];
    this.jobClients.delete(connectionString);
    await Promise.all([
      this.disconnect(connectionString, "closed"),
      ...exports.map((sql) => sql.end({ timeout: END_TIMEOUT_SEC }).catch(() => {})),
    ]);
  }

  async closeAll() {
    for (const key of new Set([...this.cache.keys(), ...this.jobClients.keys()])) await this.close(key);
  }
}

/** Thrown to leave `sql.begin()` by ROLLBACK while carrying the result out. */
class RollbackWith<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

/**
 * The same service for connections marked readonly, enforced by Postgres
 * rather than by reading the SQL. Every session starts with
 * `default_transaction_read_only`, and anything carrying SQL a person wrote —
 * typed queries, scripts, the grid's `{$$ …}` conditions — runs statement by
 * statement inside `BEGIN READ ONLY` over the extended protocol:
 *
 * - `SELECT nextval('s')`, `setval()` and a function that deletes are refused
 *   by Postgres (25006), which the SQL check alone let through;
 * - one statement per protocol message, so text the statement splitter
 *   misread as a single statement is refused, not run as two;
 * - the transaction is always rolled back, never committed: a `set_config()`
 *   that flips the session default back to read-write is undone with it.
 *
 * It does not stop `pg_terminate_backend()` and friends, which are not
 * writes; a database user with only SELECT privileges does.
 */
class ReadonlyPostgresService extends PostgresService {
  protected override sessionParams(): Record<string, string> {
    return { default_transaction_read_only: "on" };
  }

  private async readOnly<T>(connectionString: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return this.withConnection(connectionString, async (sql) => {
      try {
        await sql.begin("read only", async (tx) => { throw new RollbackWith(await fn(tx)); });
      } catch (e) {
        if (e instanceof RollbackWith) return e.value as T;
        throw e;
      }
      throw new Error("read-only transaction ended without a result");
    });
  }

  private statementsOf(sqlText: string): string[] {
    if (!isReadOnlyQuery(sqlText)) throw new ReadonlyViolationError();
    return splitSqlStatements(sqlText.trim());
  }

  /** Each statement of a Query tab run in a READ ONLY transaction of its own, always rolled back. */
  protected override async inQueryStatement<T>(sql: postgres.Sql, text: string, run: () => Promise<T>): Promise<T> {
    if (!isReadOnlyQuery(text)) {
      const refusal = new ReadonlyViolationError();
      throw new QueryStatementError(refusal.message, {}, refusal);
    }
    try {
      await sql.unsafe("BEGIN READ ONLY");
    } catch (e) {
      throw pgStatementError(e);
    }
    try {
      return await run();
    } finally {
      await sql.unsafe("ROLLBACK").catch(() => {});
    }
  }

  override async runQuery(connectionString: string, sqlText: string, opts?: RunQueryOptions): Promise<DbRunResult> {
    const statements = this.statementsOf(sqlText);
    throwIfAborted(opts);
    return this.readOnly(connectionString, async (tx) => {
      // The server's own limit as well as the client's: it holds even if PPM stops listening.
      if (opts?.timeoutMs) await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.round(opts.timeoutMs))}`);
      const start = performance.now();
      let withRows: PgResult | null = null;
      let rowsAffected = 0;
      for (const statement of statements) {
        const result = await stoppable(opts, tx.unsafe(statement, [], EXTENDED_PROTOCOL).values()) as unknown as PgResult;
        if (result.columns) withRows = result;
        else rowsAffected += Number(result.count ?? 0);
      }
      const executionTimeMs = Math.round(performance.now() - start);
      if (!withRows) return { columns: [], rows: [], rowsAffected, changeType: "modify" as const, executionTimeMs };
      return {
        columns: await this.describeResultColumns(connectionString, tx, withRows.columns),
        rows: Array.from(withRows, (row) => toJsonRow(row as unknown[])),
        rowsAffected,
        changeType: "select" as const,
        executionTimeMs,
      };
    });
  }

  override async executeQuery(connectionString: string, sqlText: string): Promise<PgQueryResult> {
    const statements = this.statementsOf(sqlText);
    return this.readOnly(connectionString, async (tx) => {
      const start = performance.now();
      let rows: postgres.RowList<postgres.Row[]> | null = null;
      for (const statement of statements) {
        const result = await tx.unsafe(statement, [], EXTENDED_PROTOCOL);
        if ((result as unknown as PgResult).columns) rows = result;
      }
      const executionTimeMs = Math.round(performance.now() - start);
      if (!rows) return { columns: [], rows: [], rowsAffected: 0, changeType: "modify" as const, executionTimeMs };
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      return { columns, rows: rows as unknown as Record<string, unknown>[], rowsAffected: 0, changeType: "select" as const, executionTimeMs };
    });
  }

  override async executeScript(connectionString: string, scriptText: string): Promise<{ statementsRun: number; executionTimeMs: number }> {
    const statements = this.statementsOf(scriptText);
    return this.readOnly(connectionString, async (tx) => {
      const start = performance.now();
      for (const statement of statements) await tx.unsafe(statement, [], EXTENDED_PROTOCOL);
      return { statementsRun: statements.length, executionTimeMs: Math.round(performance.now() - start) };
    });
  }

  override async selectRows(connectionString: string, stmt: DbStatement): Promise<DbRowSet> {
    return this.readOnly(connectionString, async (tx) => {
      const result = await tx.unsafe(stmt.sql, stmt.params as never[], EXTENDED_PROTOCOL).values() as unknown as PgResult;
      return {
        columns: await this.describeResultColumns(connectionString, tx, result.columns),
        rows: Array.from(result, (row) => toJsonRow(row as unknown[])),
      };
    });
  }

  override async countRows(connectionString: string, stmt: DbStatement, timeoutMs: number): Promise<number | null> {
    try {
      return await this.readOnly(connectionString, async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.round(timeoutMs))}`);
        const [row] = await tx.unsafe(stmt.sql, stmt.params as never[], EXTENDED_PROTOCOL);
        return Number((row as { count?: unknown } | undefined)?.count ?? 0);
      });
    } catch (e) {
      if ((e as { code?: string }).code === QUERY_CANCELED) return null;
      throw e;
    }
  }

  override async updateCell(): Promise<void> {
    throw new ReadonlyViolationError("Connection is readonly — cell editing is disabled. Change this in PPM web UI.");
  }

  override async deleteRow(): Promise<void> {
    throw new ReadonlyViolationError("Connection is readonly — row deletion is disabled. Change this in PPM web UI.");
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

export const postgresService = new PostgresService();
/** For connections marked readonly: its own pools, every session read-only. */
export const readonlyPostgresService = new ReadonlyPostgresService();
