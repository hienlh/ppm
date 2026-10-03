/**
 * What ⋮ (Choose value) and ⋯ (Lookup) write into a filter box, and what they ask the server
 * for. A value picked becomes the text that matches exactly it — every value with its own `=`,
 * joined by commas (OR), as DBGate writes them: `="active",="pending"`. The value is quoted so a
 * space or a comma stays inside it, and the column reads it in its own syntax: `="5"` is the
 * number 5 on a number column, `="2026-09-02 10:01:00"` that one second on a date column.
 */
import type { ColumnKind } from "../../../../shared/db-column-kind";
import { filterSyntax, parseAnyColumnFilter, type FilterableColumn } from "../../../../shared/db-filter-parser";
import { GRID_VALUES_LIMIT, type FilterGroup, type GridRequest, type GridValuesRequest } from "../../../../shared/db-grid";
import { filterRequest, withColumnFilter, type GridFilters } from "./grid-filters";

/**
 * Whether ⋮ is offered: a binary value cannot be written as a filter, and a JSON one compares
 * differently on every engine (Postgres `json` has no `=` at all), so a pick could only fail.
 */
export function canChooseValues(kind: ColumnKind): boolean {
  return kind !== "binary" && kind !== "json";
}

/** A value as it would be typed: objects as JSON. */
export function valueText(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/** Quoted, a quote inside doubled: the form every syntax reads as the value itself. */
export const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`;

const TRUE_TEXT = new Set(["1", "true", "t"]);
const FALSE_TEXT = new Set(["0", "false", "f"]);

/** One picked value as filter text. */
export function valueTerm(kind: ColumnKind, value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (filterSyntax(kind) === "boolean") {
    const text = valueText(value).toLowerCase();
    if (TRUE_TEXT.has(text)) return "TRUE";
    if (FALSE_TEXT.has(text)) return "FALSE";
  }
  // Anything else on a boolean column is written as it is, and the box says why it cannot read it.
  return `=${quoted(valueText(value))}`;
}

/** The values picked, as one filter; empty when none were. */
export function pickedValuesFilter(kind: ColumnKind, values: readonly unknown[]): string {
  return values.map((v) => valueTerm(kind, v)).join(",");
}

/** Tells two values apart as DISTINCT does: NULL from the text "null" — and, on SQLite, which keeps both, 1 from "1". */
export function valueKey(value: unknown): string {
  return value === null || value === undefined ? "null" : `${typeof value}:${valueText(value)}`;
}

/** The table a request reads. */
export interface TableScope {
  table: string;
  schema?: string;
}

/** ⋮: the column's values under every filter in force but its own, which is what it picks for. */
export function valuesRequest(
  scope: TableScope, column: string, search: string, filters: GridFilters, columns: readonly FilterableColumn[],
): GridValuesRequest {
  const others = filterRequest(withColumnFilter(filters, column, ""), columns);
  return { ...scope, column, search: search.trim(), filters: others.filters, anyColumn: others.anyColumn };
}

/** Rows a lookup shows at once; a search finds the others. */
export const LOOKUP_ROWS = GRID_VALUES_LIMIT;

/** ⋯: the first rows of the referenced table by its key, matching the search. */
export function lookupRowsRequest(scope: TableScope, keyColumn: string, anyColumn: FilterGroup[]): GridRequest {
  return { ...scope, anyColumn, sort: [{ column: keyColumn, dir: "ASC" }], offset: 0, limit: LOOKUP_ROWS };
}

/**
 * A lookup's search, in the key and the description, either one. The text is quoted so it is
 * read as itself — contained in a text column, equal in a number column — whatever it holds.
 * Null when neither column can read it: then nothing can match.
 */
export function lookupSearch(search: string, columns: readonly FilterableColumn[]): FilterGroup[] | null {
  const text = search.trim();
  if (!text) return [];
  const read = parseAnyColumnFilter(quoted(text), columns);
  return read.ok ? read.groups : null;
}

/** What describes a row when nothing was chosen: the first text column besides the key, as in DBGate. */
export function defaultDescription(columns: readonly FilterableColumn[], keyColumn: string): string | null {
  return columns.find((c) => c.kind === "text" && c.name !== keyColumn)?.name ?? null;
}

/** The description chosen for the table while it still has that column, and the default otherwise. */
export function descriptionColumn(columns: readonly FilterableColumn[], keyColumn: string, chosen: string | null): string | null {
  return chosen && chosen !== keyColumn && columns.some((c) => c.name === chosen) ? chosen : defaultDescription(columns, keyColumn);
}
