/**
 * The data grid's reads: `POST /connections/:id/grid` for one page,
 * `POST /connections/:id/grid/count` for the total,
 * `POST /connections/:id/grid/values` for one column's distinct values,
 * `POST /connections/:id/grid/export` for every row as a file and
 * `POST /connections/:id/grid/cell` for one cell's value whole. The browser
 * sends a structured request; the SQL is built here, for the connection's
 * dialect.
 */
import { Hono, type Context } from "hono";
import type { ConnectionRow } from "../../services/db.service.ts";
import { isReadonlyRefusal, readonlyRefusalMessage } from "../../services/database/db-errors.ts";
import { dialectFor } from "../../services/database/dialects.ts";
import { isReadOnlyQuery } from "../../services/database/readonly-check.ts";
import {
  GridRequestError, parseGridCountRequest, parseGridExportRequest, parseGridRequest, parseGridValuesRequest,
  rawSqlConditions, type GridScope,
} from "../../services/database/grid-query-builder.ts";
import {
  GRID_COUNT_TIMEOUT_MS, GRID_EXACT_COUNT_TIMEOUT_MS, GridTableNotFoundError, countGridRows, defaultSchemaFor, fetchGridPage,
  fetchGridValues, openGridExport, type GridExport,
} from "../../services/database/grid.service.ts";
import { ChangesetRequestError } from "../../services/database/changeset.ts";
import { GridCellConflictError, GridCellGoneError, parseGridCellRequest, readGridCell } from "../../services/database/grid-cell.ts";
import { rowsToRecords } from "../../shared/db-grid.ts";
import { gridExportFileName, type GridExportTicket } from "../../shared/db-grid-export.ts";
import { ok, err } from "../../types/api.ts";
import { auditCaller, logQuery } from "./query-audit-hook.ts";
import { reserveExportSlot, ticketCellDownload, ticketGridExport, TooManyExportsError } from "./database-grid-export.ts";
import { connAudit, connTarget, databaseParam, holdRequestOpen, requestDatabase, resolveTargetConn } from "./database-route-helpers.ts";

export const databaseGridRoutes = new Hono();

const READONLY_RAW_SQL = "Connection is readonly — this SQL condition is not a plain read. Change this in PPM web UI.";

/** Seconds a page read may take: a sort over a big table has nothing to send until it is done. */
const GRID_READ_SECONDS = 300;

/** Seconds past a count's own limit that the request is kept open, for the table lookup and the estimate. */
const COUNT_SLACK_SECONDS = 30;

/** Parse the body, answering 400 with the reason when it cannot become SQL. */
async function readRequest<T>(
  c: Context,
  conn: ConnectionRow,
  parse: (body: unknown, defaultSchema: string | null) => T,
): Promise<T | Response> {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(err("Request body must be JSON"), 400); }
  try {
    return parse(body, defaultSchemaFor(conn.type));
  } catch (e) {
    if (e instanceof GridRequestError) return c.json(err(e.message), 400);
    throw e;
  }
}

/**
 * A readonly connection still runs the SQL of a `{$$ …}` condition, so it gets
 * the same first check as typed SQL: nothing that looks like a write. Only a
 * column's own filter can hold one; the parser refuses it in `anyColumn`.
 */
function blocksRawSql(conn: ConnectionRow, req: GridScope): boolean {
  const dialect = dialectFor(conn.type).name;
  return !!conn.readonly && rawSqlConditions(req.filters).some((sql) => !isReadOnlyQuery(`SELECT 1 WHERE ${sql}`, dialect));
}

/** The statement a blocked request would have run, for the audit log. */
function blockedSql(conn: ConnectionRow, req: GridScope): string {
  const attempted = rawSqlConditions(req.filters).map((sql) => `(${sql})`).join(" AND ");
  return `SELECT * FROM ${dialectFor(conn.type).qualify(req.table, req.schema)} WHERE ${attempted}`;
}

/** Status for an error the grid service raised on purpose, or the database's readonly refusal; 500 for anything else. */
function errorStatus(e: unknown): 400 | 403 | 404 | 409 | 500 {
  if (e instanceof GridRequestError || e instanceof ChangesetRequestError) return 400;
  if (e instanceof GridTableNotFoundError || e instanceof GridCellGoneError) return 404;
  if (e instanceof GridCellConflictError) return 409;
  if (isReadonlyRefusal(e)) return 403;
  return 500;
}

/** POST /connections/:id/grid — one page of a table, filtered and sorted by the server. */
databaseGridRoutes.post("/:id/grid", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const req = await readRequest(c, conn, parseGridRequest);
  if (req instanceof Response) return req;
  holdRequestOpen(c, GRID_READ_SECONDS);

  // Browsing a table is not audited, as it never was; filtering is, because it
  // used to run through /query and the log should not lose those entries.
  const audited = req.filters.length > 0 || req.anyColumn.length > 0;
  const d = dialectFor(conn.type);
  const auditBase = {
    ...connAudit(conn),
    source: "filter" as const,
    operation: "select" as const,
    params: {
      ...databaseParam(c), table: req.table, schema: req.schema, filters: req.filters, anyColumn: req.anyColumn,
      sort: req.sort, offset: req.offset, limit: req.limit,
    },
  };

  if (blocksRawSql(conn, req)) {
    logQuery(c, { ...auditBase, sql: blockedSql(conn, req), status: "blocked", error: READONLY_RAW_SQL, durationMs: Date.now() - startedAt });
    return c.json(err(READONLY_RAW_SQL), 403);
  }

  try {
    const page = await fetchGridPage(connTarget(conn, requestDatabase(c)), req);
    if (audited) {
      logQuery(c, {
        ...auditBase,
        sql: `${page.built.displaySql}\n${d.limitOffset(String(req.limit + 1), String(req.offset))}`,
        status: "ok",
        rows: rowsToRecords(page.response.columns, page.response.rows).records,
        rowCount: page.response.rows.length,
        durationMs: Date.now() - startedAt,
      });
    }
    return c.json(ok(page.response));
  } catch (e) {
    const status = errorStatus(e);
    const message = status === 403 ? readonlyRefusalMessage(e) : (e as Error).message;
    if (audited && (status === 500 || status === 403)) {
      // The statement text is not known when the failure came before it was built; params hold the request.
      logQuery(c, {
        ...auditBase,
        sql: `SELECT * FROM ${d.qualify(req.table, req.schema)} WHERE …`,
        status: status === 403 ? "blocked" : "error",
        error: message,
        durationMs: Date.now() - startedAt,
      });
    }
    return c.json(err(message), status);
  }
});

/**
 * POST /connections/:id/grid/count — exact row count under the same filters,
 * plus the database's estimate. Separate from /grid so opening a large table
 * never waits on a COUNT(*); a count that runs too long answers `timedOut`.
 * `exact` is a count the user asked for, which may run far longer.
 */
databaseGridRoutes.post("/:id/grid/count", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const req = await readRequest(c, conn, parseGridCountRequest);
  if (req instanceof Response) return req;
  if (blocksRawSql(conn, req)) return c.json(err(READONLY_RAW_SQL), 403);
  const timeoutMs = req.exact ? GRID_EXACT_COUNT_TIMEOUT_MS : GRID_COUNT_TIMEOUT_MS;
  holdRequestOpen(c, timeoutMs / 1000 + COUNT_SLACK_SECONDS);

  try {
    return c.json(ok(await countGridRows(connTarget(conn, requestDatabase(c)), req, timeoutMs)));
  } catch (e) {
    const status = errorStatus(e);
    return c.json(err(status === 403 ? readonlyRefusalMessage(e) : (e as Error).message), status);
  }
});

/**
 * POST /connections/:id/grid/values — the distinct values of one column under
 * the filters given, for "Choose value". Audited and vetted like a filtered
 * page: the filters it carries are the user's, and so is a search.
 */
databaseGridRoutes.post("/:id/grid/values", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const req = await readRequest(c, conn, parseGridValuesRequest);
  if (req instanceof Response) return req;

  const audited = req.filters.length > 0 || req.anyColumn.length > 0 || req.search !== "";
  const auditBase = {
    ...connAudit(conn),
    source: "filter" as const,
    operation: "select" as const,
    params: {
      ...databaseParam(c), table: req.table, schema: req.schema, column: req.column, search: req.search,
      filters: req.filters, anyColumn: req.anyColumn,
    },
  };

  if (blocksRawSql(conn, req)) {
    logQuery(c, { ...auditBase, sql: blockedSql(conn, req), status: "blocked", error: READONLY_RAW_SQL, durationMs: Date.now() - startedAt });
    return c.json(err(READONLY_RAW_SQL), 403);
  }

  try {
    const page = await fetchGridValues(connTarget(conn, requestDatabase(c)), req);
    if (audited) {
      logQuery(c, {
        ...auditBase,
        sql: page.built.displaySql,
        status: "ok",
        rowCount: page.response.values.length,
        durationMs: Date.now() - startedAt,
      });
    }
    return c.json(ok(page.response));
  } catch (e) {
    const status = errorStatus(e);
    const message = status === 403 ? readonlyRefusalMessage(e) : (e as Error).message;
    if (audited && (status === 500 || status === 403)) {
      logQuery(c, {
        ...auditBase,
        sql: `SELECT DISTINCT … FROM ${dialectFor(conn.type).qualify(req.table, req.schema)} WHERE …`,
        status: status === 403 ? "blocked" : "error",
        error: message,
        durationMs: Date.now() - startedAt,
      });
    }
    return c.json(err(message), status);
  }
});

/**
 * POST /connections/:id/grid/export — DBGate's Export ▸: every row the grid's filters leave, in its
 * sort, the columns it shows in its order, as one file. The read starts here and its first rows are
 * read before answering, so a statement the database refuses is an error here and not a broken
 * download; the answer is the ticket the file is then fetched with (database-grid-export.ts).
 * Always audited — an export takes the table away whole — once its download has ended.
 */
databaseGridRoutes.post("/:id/grid/export", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const req = await readRequest(c, conn, parseGridExportRequest);
  if (req instanceof Response) return req;
  holdRequestOpen(c, GRID_READ_SECONDS);

  const d = dialectFor(conn.type);
  const auditBase = {
    ...connAudit(conn),
    source: "export" as const,
    operation: "select" as const,
    params: {
      ...databaseParam(c), table: req.table, schema: req.schema, filters: req.filters, anyColumn: req.anyColumn,
      sort: req.sort, columns: req.columns, format: req.format,
    },
  };

  if (blocksRawSql(conn, req)) {
    logQuery(c, { ...auditBase, sql: blockedSql(conn, req), status: "blocked", error: READONLY_RAW_SQL, durationMs: Date.now() - startedAt });
    return c.json(err(READONLY_RAW_SQL), 403);
  }

  let release: () => void;
  try {
    release = reserveExportSlot();
  } catch (e) {
    if (e instanceof TooManyExportsError) return c.json(err(e.message), 429);
    throw e;
  }

  let opened: GridExport;
  try {
    opened = await openGridExport(connTarget(conn, requestDatabase(c)), req);
  } catch (e) {
    release();
    const status = errorStatus(e);
    const message = status === 403 ? readonlyRefusalMessage(e) : (e as Error).message;
    if (status === 500 || status === 403) {
      logQuery(c, {
        ...auditBase,
        sql: `SELECT … FROM ${d.qualify(req.table, req.schema)}`,
        status: status === 403 ? "blocked" : "error",
        error: message,
        durationMs: Date.now() - startedAt,
      });
    }
    return c.json(err(message), status);
  }

  const fileName = gridExportFileName(req.table, req.format);
  const ticket = ticketGridExport(
    opened,
    { format: req.format, dialect: d, table: req.table },
    fileName,
    { caller: auditCaller(c), fields: auditBase, startedAt },
    release,
  );
  return c.json(ok<GridExportTicket>({ ticket, fileName }));
});

/**
 * POST /connections/:id/grid/cell — Save cell to file for bytes the grid has only the start of: the
 * row found again by its key, the value read whole, and the file downloaded by ticket as an
 * export's is, taking one of the same slots while it waits. Not audited, as browsing is not: the
 * row was on screen already.
 */
databaseGridRoutes.post("/:id/grid/cell", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const req = await readRequest(c, conn, parseGridCellRequest);
  if (req instanceof Response) return req;
  holdRequestOpen(c, GRID_READ_SECONDS);

  let release: () => void;
  try {
    release = reserveExportSlot();
  } catch (e) {
    if (e instanceof TooManyExportsError) return c.json(err(e.message), 429);
    throw e;
  }
  try {
    const bytes = await readGridCell(connTarget(conn, requestDatabase(c)), req);
    return c.json(ok<GridExportTicket>({ ticket: ticketCellDownload(bytes, req.fileName, release), fileName: req.fileName }));
  } catch (e) {
    release();
    const status = errorStatus(e);
    return c.json(err(status === 403 ? readonlyRefusalMessage(e) : (e as Error).message), status);
  }
});
