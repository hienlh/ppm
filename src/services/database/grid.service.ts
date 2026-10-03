/**
 * Serve the data grid: check a request against the table's real columns, build
 * the SQL for the connection's dialect, run it, and say whether more rows exist.
 */
import { GRID_VALUES_LIMIT, type GridCountResponse, type GridResponse, type GridValuesResponse } from "../../shared/db-grid.ts";
import type { DatabaseAdapter, DbConnectionConfig, DbType } from "../../types/database.ts";
import type { DialectColumn } from "./dialect.ts";
import { classifyColumnType, dialectFor } from "./dialects.ts";
import {
  buildCount, buildDistinctValues, buildExportSelect, buildSelect, type BuiltSelect, type ValidGridExportRequest, type ValidGridRequest,
  type ValidGridValuesRequest,
} from "./grid-query-builder.ts";
import type { ExportColumn } from "./grid-export.ts";
import { EXPORT_BATCH_LIMITS, type BatchLimits } from "./export-batch.ts";

/** How long an exact count may run before the grid settles for the estimate. */
export const GRID_COUNT_TIMEOUT_MS = 10_000;

/** How long a count the user asked for may run: they are waiting for it, but not forever. */
export const GRID_EXACT_COUNT_TIMEOUT_MS = 300_000;

/** A table or view the request names does not exist. Maps to HTTP 404. */
export class GridTableNotFoundError extends Error {
  readonly status = 404;
}

export interface GridTarget {
  type: DbType;
  adapter: DatabaseAdapter;
  config: DbConnectionConfig;
}

/** Schema a request falls back to when it names none. */
export function defaultSchemaFor(type: DbType): string | null {
  return type === "postgres" ? "public" : null;
}

export interface GridTable {
  columns: DialectColumn[];
  rowKey: string[];
  /** The rowid alias to select beside the columns, for a SQLite table without a primary key. */
  rowid: string | null;
}

export async function loadGridTable(target: GridTarget, table: string, schema: string | null): Promise<GridTable> {
  const found = await target.adapter.describeTable(target.config, table, schema ?? undefined);
  if (!found || found.columns.length === 0) {
    throw new GridTableNotFoundError(schema ? `Table "${schema}.${table}" not found` : `Table "${table}" not found`);
  }
  return {
    columns: found.columns.map((c) => ({ ...c, kind: classifyColumnType(target.type, c.type) })),
    rowKey: found.rowKey,
    rowid: found.rowKeyIsRowid ? found.rowKey[0] ?? null : null,
  };
}

export interface GridPage {
  response: GridResponse;
  /** The statement that ran, for the audit log. */
  built: BuiltSelect;
}

export async function fetchGridPage(target: GridTarget, req: ValidGridRequest): Promise<GridPage> {
  const table = await loadGridTable(target, req.table, req.schema);
  // One row past the page answers "is there more?" without a COUNT(*).
  const built = buildSelect(dialectFor(target.type), table.columns, req, req.limit + 1, table.rowid);
  const result = await target.adapter.selectRows(target.config, built);
  const hasMore = result.rows.length > req.limit;
  // The SELECT lists the catalog's columns in catalog order, so the catalog's
  // declared types (`character varying(255)`) describe them better than the
  // driver's type ids do.
  const columns = table.columns.map(({ name, type }) => ({ name, type }));
  if (table.rowid) columns.push({ name: table.rowid, type: "INTEGER" });
  return {
    built,
    response: {
      columns,
      rows: hasMore ? result.rows.slice(0, req.limit) : result.rows,
      hasMore,
      sql: built.displaySql,
      rowKey: table.rowKey,
    },
  };
}

export async function countGridRows(
  target: GridTarget,
  req: ValidGridRequest,
  timeoutMs = GRID_COUNT_TIMEOUT_MS,
): Promise<GridCountResponse> {
  const { columns } = await loadGridTable(target, req.table, req.schema);
  const stmt = buildCount(dialectFor(target.type), columns, req);
  // Statistics describe the whole table; with filters on they would mislead.
  const estimate = req.filters.length === 0 && req.anyColumn.length === 0
    ? await target.adapter.estimateRows(target.config, req.table, req.schema ?? undefined).catch(() => null)
    : null;
  const count = await target.adapter.countRows(target.config, stmt, timeoutMs);
  return { count, estimate, timedOut: count === null };
}

export interface GridValuesPage {
  response: GridValuesResponse;
  built: BuiltSelect;
}

/** Up to `GRID_VALUES_LIMIT` distinct values of one column, and whether there are more. */
export async function fetchGridValues(target: GridTarget, req: ValidGridValuesRequest): Promise<GridValuesPage> {
  const { columns } = await loadGridTable(target, req.table, req.schema);
  const built = buildDistinctValues(dialectFor(target.type), columns, req, GRID_VALUES_LIMIT + 1);
  const { rows } = await target.adapter.selectRows(target.config, built);
  return {
    built,
    response: {
      values: rows.slice(0, GRID_VALUES_LIMIT).map((row) => row[0]),
      hasMore: rows.length > GRID_VALUES_LIMIT,
      sql: built.displaySql,
    },
  };
}

export interface GridExport {
  /** The statement that runs, for the audit log. */
  built: BuiltSelect;
  columns: ExportColumn[];
  /** The rows, a batch at a time, the first already read. Ending the iteration early ends the read. */
  batches: AsyncGenerator<unknown[][]>;
  /** End the read without iterating: for an export whose download never started. */
  close(): Promise<void>;
}

/**
 * Start an export: its columns checked against the table, its statement built, run, and the first
 * rows read — so a statement the database refuses fails here, not halfway through a download.
 */
export async function openGridExport(
  target: GridTarget, req: ValidGridExportRequest, limits: BatchLimits = EXPORT_BATCH_LIMITS,
): Promise<GridExport> {
  const table = await loadGridTable(target, req.table, req.schema);
  const built = buildExportSelect(dialectFor(target.type), table.columns, req);
  const source = target.adapter.streamRows(target.config, built, limits);
  const first = await source.next();
  async function* batches(): AsyncGenerator<unknown[][]> {
    try {
      if (first.done) return;
      yield first.value;
      yield* source;
    } finally {
      await source.return(undefined);
    }
  }
  return {
    built,
    columns: built.columns.map(({ name, kind }) => ({ name, kind })),
    batches: batches(),
    close: async () => { await source.return(undefined); },
  };
}
