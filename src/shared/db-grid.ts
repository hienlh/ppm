/**
 * The request the data grid sends and the shape the server answers with.
 * Shared because the browser builds a `GridRequest` from what the user typed
 * and the server turns it into SQL: the browser never writes SQL for the grid,
 * which is what lets each database get its own syntax (SQLite has no `ILIKE`,
 * MySQL quotes with backticks) and keeps every value out of the statement text.
 */

/** Comparison a single filter condition applies to one column. */
export type FilterOp =
  | "eq" | "ne" | "gt" | "ge" | "lt" | "le"
  | "contains" | "notContains"
  | "startsWith" | "notStartsWith"
  | "endsWith" | "notEndsWith"
  | "isNull" | "notNull"
  | "isEmpty" | "notEmpty"
  | "in"
  | "dateRange"
  | "isTrue" | "isFalse"
  | "rawSql";

export const FILTER_OPS: readonly FilterOp[] = [
  "eq", "ne", "gt", "ge", "lt", "le",
  "contains", "notContains", "startsWith", "notStartsWith", "endsWith", "notEndsWith",
  "isNull", "notNull", "isEmpty", "notEmpty",
  "in", "dateRange", "isTrue", "isFalse", "rawSql",
];

export type FilterValue = string | number | boolean | null;

export interface FilterCondition {
  op: FilterOp;
  /** Operand of the comparison and text operators. */
  value?: FilterValue;
  /** Operand of `in`. */
  values?: FilterValue[];
  /**
   * Bounds of `dateRange`, start included and end excluded. Wall-clock time as
   * the user meant it (`2024-02-15 00:00:00`); `offset` says which zone that
   * was, for columns that store an instant rather than a wall-clock value.
   */
  from?: string;
  to?: string;
  /** The browser's UTC offset when `from`/`to` were computed, e.g. `+07:00`. */
  offset?: string;
  /** `rawSql`: a condition written in SQL, with `$$` standing for the column. */
  sql?: string;
}

/**
 * Every condition typed for one column. `anyOf` is an OR of AND-groups, which
 * is how DBGate reads a filter cell: a space joins with AND, a comma with OR,
 * and AND binds tighter — `canada lake, usa` is `[[canada, lake], [usa]]`.
 */
export interface FilterGroup {
  column: string;
  anyOf: FilterCondition[][];
}

export type SortDir = "ASC" | "DESC";

export interface GridSort {
  column: string;
  dir: SortDir;
}

export interface GridRequest {
  table: string;
  /** Postgres/MySQL schema; ignored for SQLite. Defaults to `public` on Postgres. */
  schema?: string;
  /** Columns are joined with AND. */
  filters?: FilterGroup[];
  /**
   * The Multi column filter: one text read for every column that can read it
   * (`parseAnyColumnFilter`), these groups joined with OR and the whole joined
   * with `filters` by AND. Read in the browser, so `TODAY` is the user's day.
   */
  anyColumn?: FilterGroup[];
  /** Applied in order: the first entry is the primary sort. */
  sort?: GridSort[];
  offset?: number;
  limit?: number;
}

/** One result column as the driver described it. Names may repeat. */
export interface ResultColumn {
  name: string;
  type: string;
}

/**
 * A binary value, as JSON can carry one. `data` is base64 and may hold only the
 * start of the value (`truncated`) — the grid shows the size and a preview,
 * and nothing is gained by sending megabytes the user never opens.
 */
export interface DbBinaryValue {
  $binary: string;
  size: number;
  truncated?: boolean;
}

export interface GridResponse {
  columns: ResultColumn[];
  /** One array per row, values in `columns` order, so repeated names survive. */
  rows: unknown[][];
  /** True when at least one more row exists after this page. */
  hasMore: boolean;
  /**
   * The grid's SELECT with its filters and sort and without paging, values
   * written out as literals. For display and for "Open query" — the statement
   * that actually ran used parameters.
   */
  sql: string;
  /**
   * Columns whose values address a row in a changeset: the primary key, or
   * SQLite's rowid for a table without one — which the table itself does not
   * list, so it comes as the last entry of `columns`. Empty when rows cannot be
   * addressed, and the grid is then read-only.
   */
  rowKey: string[];
}

/**
 * `POST /connections/:id/grid/values`: the distinct values of one column under
 * the filters given — the list "Choose value" offers. The browser leaves the
 * column's own filter out, so the list shows what that filter could pick from.
 */
export interface GridValuesRequest {
  table: string;
  schema?: string;
  column: string;
  /** Only values whose text contains this, case-insensitively. */
  search?: string;
  filters?: FilterGroup[];
  anyColumn?: FilterGroup[];
}

export interface GridValuesResponse {
  /** Sorted, at most `GRID_VALUES_LIMIT`; `null` is one of them when the column holds a NULL. */
  values: unknown[];
  /** More distinct values exist than were sent. */
  hasMore: boolean;
  /** The SELECT that listed them, values written out as literals. */
  sql: string;
}

/** Distinct values one "Choose value" list shows. */
export const GRID_VALUES_LIMIT = 100;

/** Longest text a values search may be. */
export const GRID_VALUES_MAX_SEARCH = 1_000;

/**
 * `POST /connections/:id/grid/count`: the rows a grid request matches. Paging fields are ignored.
 * `exact` asks for a count the user waits for (DBGate's "Rows: Many" clicked): it may run far
 * longer than the background count does.
 */
export interface GridCountRequest extends GridRequest {
  exact?: boolean;
}

export interface GridCountResponse {
  /** Exact row count, or null when counting took longer than allowed. */
  count: number | null;
  /** The database's own estimate (Postgres statistics), when it has one. */
  estimate: number | null;
  timedOut: boolean;
}

/** What `POST /connections/:id/query` answers: the driver's columns, rows as arrays. */
export interface QueryRunResponse {
  columns: ResultColumn[];
  rows: unknown[][];
  rowsAffected: number;
  changeType: "select" | "modify";
  executionTimeMs: number;
  /** True when a row cap cut the result short. */
  truncated?: boolean;
}

/** The same result with rows as objects, for views that render records. */
export interface QueryRecordsResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  changeType: "select" | "modify";
  executionTimeMs?: number;
  truncated?: boolean;
}

/** Rows one grid request may ask for. Fetching more goes page by page. */
export const GRID_MAX_LIMIT = 10_000;
export const GRID_DEFAULT_LIMIT = 100;

/** Upper bound on `in` values, so a pasted list cannot exceed driver limits. */
export const FILTER_MAX_IN_VALUES = 5_000;

/** Longest SQL a `rawSql` condition may contain. */
export const FILTER_MAX_RAW_SQL = 4_000;

/**
 * Keys that tell apart columns sharing a name, for code that needs rows as
 * objects: the first `id` stays `id`, the next becomes `id (2)`. A key that
 * would collide with a real column name moves on to the next number.
 */
export function uniqueColumnKeys(names: readonly string[]): string[] {
  const taken = new Set(names);
  const used = new Set<string>();
  return names.map((name) => {
    if (!used.has(name)) { used.add(name); return name; }
    let n = 2;
    while (used.has(`${name} (${n})`) || taken.has(`${name} (${n})`)) n++;
    const key = `${name} (${n})`;
    used.add(key);
    return key;
  });
}

/** Array rows as objects keyed by `uniqueColumnKeys`, so no value is dropped. */
export function rowsToRecords(columns: readonly { name: string }[], rows: readonly (readonly unknown[])[]): { keys: string[]; records: Record<string, unknown>[] } {
  const keys = uniqueColumnKeys(columns.map((c) => c.name));
  const records = rows.map((row) => {
    const record: Record<string, unknown> = {};
    keys.forEach((key, i) => { record[key] = row[i]; });
    return record;
  });
  return { keys, records };
}

/** A `/query` result keyed by column name; repeated names get their own key. */
export function queryResultRecords(result: QueryRunResponse): QueryRecordsResult {
  const { keys, records } = rowsToRecords(result.columns, result.rows);
  return { ...result, columns: keys, rows: records };
}
