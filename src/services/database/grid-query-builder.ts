/**
 * Turn a structured `GridRequest` into SQL for one dialect.
 *
 * Every value becomes a bound parameter; the only text that reaches the
 * statement is identifiers — quoted, and only after they matched a column the
 * table really has — and the SQL of a `rawSql` condition, which the user typed
 * on purpose (DBGate's `{$$ > 5}`). The same code renders the display form of
 * the statement by binding values as literals instead of placeholders, so the
 * SQL a person sees is the SQL that ran, not a second rendering that can drift.
 */
import {
  FILTER_MAX_IN_VALUES, FILTER_MAX_RAW_SQL, FILTER_OPS, GRID_DEFAULT_LIMIT, GRID_MAX_LIMIT, GRID_VALUES_MAX_SEARCH,
  type FilterCondition, type FilterGroup, type FilterOp, type FilterValue, type GridSort, type SortDir,
} from "../../shared/db-grid.ts";
import { GRID_EXPORT_MAX_COLUMNS, isGridExportFormat, type GridExportFormat } from "../../shared/db-grid-export.ts";
import { stripSqlNoise } from "../fs-ops/sql-statement-guard.ts";
import { likePattern, type DialectColumn, type SqlDialect } from "./dialect.ts";

/** A request the grid sent that cannot be turned into SQL. Maps to HTTP 400. */
export class GridRequestError extends Error {
  readonly status = 400;
}

/** What a grid read is over: a table and the rows its filters leave. */
export interface GridScope {
  table: string;
  schema: string | null;
  filters: FilterGroup[];
  anyColumn: FilterGroup[];
}

export interface ValidGridRequest extends GridScope {
  sort: GridSort[];
  offset: number;
  limit: number;
}

export interface ValidGridCountRequest extends ValidGridRequest {
  /** Counted on request rather than in the background: allowed to run much longer. */
  exact: boolean;
}

export interface ValidGridValuesRequest extends GridScope {
  column: string;
  search: string;
}

export interface ValidGridExportRequest extends GridScope {
  sort: GridSort[];
  /** The ones the grid shows, in its order. */
  columns: string[];
  format: GridExportFormat;
}

export interface BuiltStatement {
  sql: string;
  params: unknown[];
}

export interface BuiltSelect extends BuiltStatement {
  /** Same SELECT without paging and with values as literals — for people to read, and what Export advanced runs. */
  displaySql: string;
}

type Bind = (value: unknown) => string;

const OPS = new Set<string>(FILTER_OPS);
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?$/;
const UTC_OFFSET = /^(Z|[+-]\d{2}:\d{2})$/;

function fail(message: string): never {
  throw new GridRequestError(message);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isScalar(x: unknown): x is FilterValue {
  return x === null || typeof x === "string" || typeof x === "number" || typeof x === "boolean";
}

function intInRange(raw: unknown, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw)) fail(`${name} must be an integer`);
  if (raw < min || raw > max) fail(`${name} must be between ${min} and ${max}`);
  return raw;
}

function parseCondition(raw: unknown, column: string): FilterCondition {
  if (!isRecord(raw) || typeof raw.op !== "string" || !OPS.has(raw.op)) {
    fail(`Unknown filter operator on column "${column}"`);
  }
  const op = raw.op as FilterOp;
  const cond: FilterCondition = { op };
  switch (op) {
    case "eq": case "ne": case "gt": case "ge": case "lt": case "le":
      if (!isScalar(raw.value)) fail(`Filter "${op}" on "${column}" needs a value`);
      cond.value = raw.value;
      break;
    case "contains": case "notContains": case "startsWith": case "notStartsWith": case "endsWith": case "notEndsWith":
      if (typeof raw.value !== "string" && typeof raw.value !== "number") fail(`Filter "${op}" on "${column}" needs text`);
      cond.value = String(raw.value);
      break;
    case "in": {
      if (!Array.isArray(raw.values) || raw.values.length === 0) fail(`Filter "in" on "${column}" needs at least one value`);
      if (raw.values.length > FILTER_MAX_IN_VALUES) fail(`Filter "in" on "${column}" has more than ${FILTER_MAX_IN_VALUES} values`);
      if (!raw.values.every(isScalar)) fail(`Filter "in" on "${column}" has a value that is not text, a number or a boolean`);
      cond.values = raw.values as FilterValue[];
      break;
    }
    case "dateRange": {
      const from = raw.from, to = raw.to, offset = raw.offset;
      if (from === undefined && to === undefined) fail(`Filter "dateRange" on "${column}" needs a start or an end`);
      for (const [name, v] of [["from", from], ["to", to]] as const) {
        if (v !== undefined && (typeof v !== "string" || !WALL_CLOCK.test(v))) fail(`Filter "dateRange" on "${column}": ${name} must look like 2024-02-15 or 2024-02-15 10:00:00`);
      }
      if (offset !== undefined && (typeof offset !== "string" || !UTC_OFFSET.test(offset))) fail(`Filter "dateRange" on "${column}": offset must look like +07:00`);
      if (from !== undefined) cond.from = from as string;
      if (to !== undefined) cond.to = to as string;
      if (offset !== undefined) cond.offset = offset as string;
      break;
    }
    case "rawSql": {
      const sql = raw.sql;
      if (typeof sql !== "string" || !sql.trim()) fail(`SQL condition on "${column}" is empty`);
      if (sql.length > FILTER_MAX_RAW_SQL) fail(`SQL condition on "${column}" is longer than ${FILTER_MAX_RAW_SQL} characters`);
      // The condition lands inside one SELECT; a `;` would try to start a second statement.
      if (stripSqlNoise(sql).includes(";")) fail(`SQL condition on "${column}" may not contain ";"`);
      cond.sql = sql;
      break;
    }
    default:
      break; // isNull, notNull, isEmpty, notEmpty, isTrue, isFalse take no operand
  }
  return cond;
}

function parseFilterGroup(raw: unknown): FilterGroup {
  if (!isRecord(raw) || typeof raw.column !== "string" || !raw.column) fail("Every filter needs a column");
  const column = raw.column;
  if (!Array.isArray(raw.anyOf) || raw.anyOf.length === 0) fail(`Filter on "${column}" has no conditions`);
  const anyOf = raw.anyOf.map((group) => {
    if (!Array.isArray(group) || group.length === 0) fail(`Filter on "${column}" has an empty condition group`);
    return group.map((c) => parseCondition(c, column));
  });
  return { column, anyOf };
}

function parseSort(raw: unknown): GridSort {
  if (!isRecord(raw) || typeof raw.column !== "string" || !raw.column) fail("Every sort needs a column");
  const dir = typeof raw.dir === "string" ? raw.dir.toUpperCase() : "ASC";
  if (dir !== "ASC" && dir !== "DESC") fail(`Sort direction must be ASC or DESC`);
  return { column: raw.column, dir: dir as SortDir };
}

/**
 * Check the shape of a request body. Column names are checked later, against
 * the table's real columns, because only the database knows those.
 */
function parseScope(body: unknown, defaultSchema: string | null): { body: Record<string, unknown>; scope: GridScope } {
  if (!isRecord(body)) fail("Request body must be an object");
  if (typeof body.table !== "string" || !body.table) fail("table is required");
  if (body.schema !== undefined && body.schema !== null && typeof body.schema !== "string") fail("schema must be text");
  if (body.filters !== undefined && !Array.isArray(body.filters)) fail("filters must be a list");
  if (body.anyColumn !== undefined && !Array.isArray(body.anyColumn)) fail("anyColumn must be a list");
  const anyColumn = ((body.anyColumn as unknown[] | undefined) ?? []).map(parseFilterGroup);
  // `$$` names one column; across all of them it means nothing.
  if (rawSqlConditions(anyColumn).length > 0) fail("An SQL condition only works in one column's own filter");
  return {
    body,
    scope: {
      table: body.table,
      schema: (typeof body.schema === "string" && body.schema) ? body.schema : defaultSchema,
      filters: ((body.filters as unknown[] | undefined) ?? []).map(parseFilterGroup),
      anyColumn,
    },
  };
}

export function parseGridRequest(raw: unknown, defaultSchema: string | null): ValidGridRequest {
  const { body, scope } = parseScope(raw, defaultSchema);
  if (body.sort !== undefined && !Array.isArray(body.sort)) fail("sort must be a list");
  return {
    ...scope,
    sort: ((body.sort as unknown[] | undefined) ?? []).map(parseSort),
    offset: intInRange(body.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    limit: intInRange(body.limit, "limit", GRID_DEFAULT_LIMIT, 1, GRID_MAX_LIMIT),
  };
}

export function parseGridCountRequest(raw: unknown, defaultSchema: string | null): ValidGridCountRequest {
  const req = parseGridRequest(raw, defaultSchema);
  const exact = (raw as { exact?: unknown }).exact;
  if (exact !== undefined && typeof exact !== "boolean") fail("exact must be true or false");
  return { ...req, exact: exact === true };
}

export function parseGridValuesRequest(raw: unknown, defaultSchema: string | null): ValidGridValuesRequest {
  const { body, scope } = parseScope(raw, defaultSchema);
  if (typeof body.column !== "string" || !body.column) fail("column is required");
  if (body.search !== undefined && body.search !== null && typeof body.search !== "string") fail("search must be text");
  const search = typeof body.search === "string" ? body.search : "";
  if (search.length > GRID_VALUES_MAX_SEARCH) fail(`search may hold at most ${GRID_VALUES_MAX_SEARCH} characters`);
  return { ...scope, column: body.column, search };
}

export function parseGridExportRequest(raw: unknown, defaultSchema: string | null): ValidGridExportRequest {
  const { body, scope } = parseScope(raw, defaultSchema);
  if (body.sort !== undefined && !Array.isArray(body.sort)) fail("sort must be a list");
  if (!isGridExportFormat(body.format)) fail("format is not one Export writes");
  if (!Array.isArray(body.columns) || body.columns.length === 0) fail("columns must list at least one column");
  if (body.columns.length > GRID_EXPORT_MAX_COLUMNS) fail(`columns may list at most ${GRID_EXPORT_MAX_COLUMNS} columns`);
  if (!body.columns.every((c) => typeof c === "string" && c)) fail("Every column must be a name");
  const columns = body.columns as string[];
  if (new Set(columns).size !== columns.length) fail("A column is listed twice");
  return { ...scope, sort: ((body.sort as unknown[] | undefined) ?? []).map(parseSort), columns, format: body.format };
}

function columnLookup(columns: DialectColumn[]): (name: string) => DialectColumn {
  const byName = new Map(columns.map((c) => [c.name, c]));
  return (name) => byName.get(name) ?? fail(`Unknown column "${name}"`);
}

function renderCondition(d: SqlDialect, col: DialectColumn, cond: FilterCondition, bind: Bind): string {
  const c = d.quoteIdent(col.name);
  const text = () => String(cond.value ?? "");
  switch (cond.op) {
    case "eq": return cond.value === null ? `${c} IS NULL` : `${c} = ${bind(cond.value)}`;
    case "ne": return cond.value === null ? `${c} IS NOT NULL` : `${c} <> ${bind(cond.value)}`;
    case "gt": return `${c} > ${bind(cond.value)}`;
    case "ge": return `${c} >= ${bind(cond.value)}`;
    case "lt": return `${c} < ${bind(cond.value)}`;
    case "le": return `${c} <= ${bind(cond.value)}`;
    case "contains": return d.likeInsensitive(c, bind(likePattern(text(), "contains")), col);
    case "notContains": return `NOT (${d.likeInsensitive(c, bind(likePattern(text(), "contains")), col)})`;
    case "startsWith": return d.likeInsensitive(c, bind(likePattern(text(), "startsWith")), col);
    case "notStartsWith": return `NOT (${d.likeInsensitive(c, bind(likePattern(text(), "startsWith")), col)})`;
    case "endsWith": return d.likeInsensitive(c, bind(likePattern(text(), "endsWith")), col);
    case "notEndsWith": return `NOT (${d.likeInsensitive(c, bind(likePattern(text(), "endsWith")), col)})`;
    case "isNull": return `${c} IS NULL`;
    case "notNull": return `${c} IS NOT NULL`;
    case "isEmpty": return `(${c} IS NULL OR TRIM(${d.asText(c, col)}) = '')`;
    case "notEmpty": return `(${c} IS NOT NULL AND TRIM(${d.asText(c, col)}) <> '')`;
    case "isTrue": return d.isTrue(c);
    case "isFalse": return d.isFalse(c);
    case "in": {
      const values = cond.values ?? [];
      const present = values.filter((v) => v !== null);
      const parts: string[] = [];
      if (present.length > 0) parts.push(`${c} IN (${present.map(bind).join(", ")})`);
      if (present.length < values.length) parts.push(`${c} IS NULL`);
      return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
    }
    case "dateRange": {
      const operand = d.dateOperand(c, col);
      const parts: string[] = [];
      if (cond.from !== undefined) parts.push(`${operand} >= ${bind(d.dateBound(cond.from, cond.offset, col))}`);
      if (cond.to !== undefined) parts.push(`${operand} < ${bind(d.dateBound(cond.to, cond.offset, col))}`);
      return parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`;
    }
    case "rawSql":
      // Newlines keep a trailing `--` comment from swallowing the closing parenthesis.
      return `(\n${(cond.sql ?? "").split("$$").join(c)}\n)`;
  }
}

function renderGroup(d: SqlDialect, col: DialectColumn, group: FilterGroup, bind: Bind): string {
  const ors = group.anyOf.map((ands) => {
    const parts = ands.map((cond) => renderCondition(d, col, cond, bind));
    return parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`;
  });
  return ors.length === 1 ? ors[0]! : `(${ors.join(" OR ")})`;
}

/** Every column's filter, AND-ed, and the Multi column filter's columns OR-ed among themselves. */
function renderWhere(
  d: SqlDialect,
  find: (name: string) => DialectColumn,
  scope: Pick<GridScope, "filters" | "anyColumn">,
  bind: Bind,
): string {
  const parts = scope.filters.map((g) => renderGroup(d, find(g.column), g, bind));
  if (scope.anyColumn.length > 0) {
    const ors = scope.anyColumn.map((g) => renderGroup(d, find(g.column), g, bind));
    parts.push(ors.length === 1 ? ors[0]! : `(${ors.join("\nOR ")})`);
  }
  return parts.length > 0 ? `WHERE ${parts.join("\nAND ")}` : "";
}

function renderOrderBy(d: SqlDialect, find: (name: string) => DialectColumn, sort: GridSort[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const s of sort) {
    const col = find(s.column);
    if (seen.has(col.name)) continue;
    seen.add(col.name);
    parts.push(`${d.quoteIdent(col.name)} ${s.dir}`);
  }
  return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
}

function literalBinder(d: SqlDialect): Bind {
  return (value) => d.literal(value);
}

function paramBinder(d: SqlDialect): { bind: Bind; params: unknown[] } {
  const params: unknown[] = [];
  return { params, bind: (value) => { params.push(value); return d.placeholder(params.length); } };
}

function assemble(parts: string[]): string {
  return parts.filter(Boolean).join("\n");
}

/**
 * The page SELECT. `fetchLimit` may exceed `req.limit` — the service asks for
 * one extra row to learn whether another page exists. `rowid` is selected last
 * for a SQLite table whose rows are addressed by it; filters and sort cannot
 * name it, since it is not one of the table's columns.
 */
export function buildSelect(
  d: SqlDialect,
  columns: DialectColumn[],
  req: ValidGridRequest,
  fetchLimit = req.limit,
  rowid: string | null = null,
): BuiltSelect {
  if (columns.length === 0) fail(`Table "${req.table}" has no columns`);
  const find = columnLookup(columns);
  const selected = [...columns.map((c) => c.name), ...(rowid ? [rowid] : [])];
  const select = `SELECT ${selected.map((name) => d.quoteIdent(name)).join(", ")}`;
  const from = `FROM ${d.qualify(req.table, req.schema)}`;
  const orderBy = renderOrderBy(d, find, req.sort);

  const { bind, params } = paramBinder(d);
  const where = renderWhere(d, find, req, bind);
  const paging = d.limitOffset(bind(fetchLimit), bind(req.offset));

  return {
    sql: assemble([select, from, where, orderBy, paging]),
    params,
    displaySql: assemble([select, from, renderWhere(d, find, req, literalBinder(d)), orderBy]),
  };
}

/**
 * What Export reads: the grid's SELECT without its paging, of the columns it shows in its order.
 * `columns` are the table's, each one the request names found among them.
 */
export function buildExportSelect(d: SqlDialect, columns: DialectColumn[], req: ValidGridExportRequest): BuiltSelect & { columns: DialectColumn[] } {
  const find = columnLookup(columns);
  const chosen = req.columns.map(find);
  const statement = (bind: Bind) => [
    `SELECT ${chosen.map((c) => d.quoteIdent(c.name)).join(", ")}`,
    `FROM ${d.qualify(req.table, req.schema)}`,
    renderWhere(d, find, req, bind),
    renderOrderBy(d, find, req.sort),
  ];
  const { bind, params } = paramBinder(d);
  return { sql: assemble(statement(bind)), params, displaySql: assemble(statement(literalBinder(d))), columns: chosen };
}

/** COUNT(*) over the same filters. Sort and paging do not change a count. */
export function buildCount(d: SqlDialect, columns: DialectColumn[], req: ValidGridRequest): BuiltStatement {
  const find = columnLookup(columns);
  const { bind, params } = paramBinder(d);
  const where = renderWhere(d, find, req, bind);
  return { sql: assemble([`SELECT COUNT(*) AS count`, `FROM ${d.qualify(req.table, req.schema)}`, where]), params };
}

/**
 * The distinct values of one column under the request's filters, sorted, for
 * "Choose value". A search keeps the values whose text contains it, the same
 * test a plain word in the filter row makes.
 */
export function buildDistinctValues(d: SqlDialect, columns: DialectColumn[], req: ValidGridValuesRequest, fetchLimit: number): BuiltSelect {
  const find = columnLookup(columns);
  const column = d.quoteIdent(find(req.column).name);
  const search: FilterGroup[] = req.search ? [{ column: req.column, anyOf: [[{ op: "contains", value: req.search }]] }] : [];
  const scope = { filters: [...req.filters, ...search], anyColumn: req.anyColumn };
  const statement = (bind: Bind) => [
    `SELECT DISTINCT ${column}`,
    `FROM ${d.qualify(req.table, req.schema)}`,
    renderWhere(d, find, scope, bind),
    `ORDER BY ${column}`,
  ];
  const { bind, params } = paramBinder(d);
  // Built in reading order, so the paging placeholders come after the filters'.
  const sql = assemble([...statement(bind), d.limitOffset(bind(fetchLimit), bind(0))]);
  return { sql, params, displaySql: assemble(statement(literalBinder(d))) };
}

/** True when any condition carries SQL the user wrote, which readonly must vet. */
export function rawSqlConditions(filters: FilterGroup[]): string[] {
  return filters.flatMap((g) => g.anyOf.flat().filter((c) => c.op === "rawSql").map((c) => c.sql ?? ""));
}
