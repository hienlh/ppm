/**
 * A table view's filters as they were typed: one text per column in the filter row, and the
 * Filters panel's Multi column filter. The text is all that is kept. Every dialog that builds a
 * filter writes text into a cell, and the request is read from the text each time it is sent —
 * so a filter typed by hand and one a dialog built cannot disagree, and `TODAY` is always today.
 */
import { classifyColumnType, type ColumnKind } from "../../../../shared/db-column-kind";
import { parseAnyColumnFilter, parseFilter, type FilterableColumn, type FilterSyntaxError } from "../../../../shared/db-filter-parser";
import type { FilterGroup } from "../../../../shared/db-grid";
import type { DbType } from "../../../../shared/db-types";

/** One filter: what was typed, and whether the Filters panel has it switched off. */
export interface FilterText {
  text: string;
  /** Kept but not applied. */
  off?: boolean;
}

export interface GridFilters {
  /** By column name; a column with no filter has no entry. */
  columns: Record<string, FilterText>;
  /** The Multi column filter: one text read by every column of the table. */
  multi?: FilterText;
}

export const NO_FILTERS: GridFilters = { columns: {} };

/** What a filter cell shows. A text nothing can read is `bad` even when switched off. */
export type FilterState =
  | { state: "empty" }
  | { state: "ok" }
  | { state: "off" }
  | { state: "bad"; error: FilterSyntaxError };

const EMPTY: FilterState = { state: "empty" };

/** How every column of the table reads a filter, from the types the server reported. */
export function filterableColumns(schema: readonly { name: string; type: string }[], dbType: DbType | undefined): FilterableColumn[] {
  return schema.map((c) => ({ name: c.name, kind: dbType ? classifyColumnType(dbType, c.type) : "other" }));
}

function stateOf(filter: FilterText | undefined, read: (text: string) => { ok: true } | { ok: false; error: FilterSyntaxError }): FilterState {
  if (!filter || !filter.text.trim()) return EMPTY;
  const result = read(filter.text);
  if (!result.ok) return { state: "bad", error: result.error };
  return { state: filter.off ? "off" : "ok" };
}

/** The state of one column's filter, read in that column's syntax. */
export function columnFilterState(filter: FilterText | undefined, kind: ColumnKind, now = new Date()): FilterState {
  return stateOf(filter, (text) => parseFilter(text, kind, now));
}

/** The state of the Multi column filter, which is wrong only when no column can read it. */
export function multiFilterState(filter: FilterText | undefined, columns: readonly FilterableColumn[], now = new Date()): FilterState {
  return stateOf(filter, (text) => parseAnyColumnFilter(text, columns, now));
}

/** What the filters ask of the server. */
export interface FilterRequest {
  filters: FilterGroup[];
  anyColumn: FilterGroup[];
}

/**
 * The filters in force: every column's that reads and is switched on, in the table's column
 * order, and the Multi column filter's groups. A filter that does not read is left out, as
 * DBGate leaves it out, and so is one naming a column the table no longer has.
 */
export function filterRequest(filters: GridFilters, columns: readonly FilterableColumn[], now = new Date()): FilterRequest {
  const groups = columns.flatMap((c): FilterGroup[] => {
    const f = filters.columns[c.name];
    if (!f || f.off) return [];
    const read = parseFilter(f.text, c.kind, now);
    return read.ok && read.anyOf.length > 0 ? [{ column: c.name, anyOf: read.anyOf }] : [];
  });
  const multi = filters.multi;
  const any = multi && !multi.off ? parseAnyColumnFilter(multi.text, columns, now) : null;
  return { filters: groups, anyColumn: any?.ok ? any.groups : [] };
}

/** The filters with one column's text replaced; a blank text removes the filter. Typing switches it back on. */
export function withColumnFilter(filters: GridFilters, column: string, text: string): GridFilters {
  const columns = { ...filters.columns };
  if (text.trim()) columns[column] = { text };
  else delete columns[column];
  return { ...filters, columns };
}

/** The filters with the Multi column filter's text replaced. */
export function withMultiFilter(filters: GridFilters, text: string): GridFilters {
  const { multi: _drop, ...rest } = filters;
  return text.trim() ? { ...rest, multi: { text } } : rest;
}

const switched = (f: FilterText, off: boolean): FilterText => (off ? { text: f.text, off: true } : { text: f.text });

/** The filters with one switched on or off, as the Filters panel's checkbox does; `null` is the Multi column filter. */
export function withFilterOff(filters: GridFilters, column: string | null, off: boolean): GridFilters {
  if (column === null) return filters.multi ? { ...filters, multi: switched(filters.multi, off) } : filters;
  const f = filters.columns[column];
  return f ? { ...filters, columns: { ...filters.columns, [column]: switched(f, off) } } : filters;
}

/** Whether there is any filter, in force or switched off. */
export function hasFilters(filters: GridFilters): boolean {
  return Object.keys(filters.columns).length > 0 || !!filters.multi?.text.trim();
}

/** The filters without those on a column the table no longer has, which nothing could show or apply. */
export function filtersOnColumns(filters: GridFilters, columns: readonly FilterableColumn[]): GridFilters {
  const names = new Set(columns.map((c) => c.name));
  const kept = Object.entries(filters.columns).filter(([name]) => names.has(name));
  return kept.length === Object.keys(filters.columns).length ? filters : { ...filters, columns: Object.fromEntries(kept) };
}

// ─── Kept in the tab ─────────────────────────────────────────────────────────

/** The metadata field a table tab keeps its filters under, those switched off too. */
export const TAB_FILTERS_FIELD = "filters";

/** What a tab may hand back: a damaged one must not give the grid megabytes of text to read. */
export const TAB_FILTER_CAPS = { columns: 1_000, name: 1_000, text: 10_000 } as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function keptText(v: unknown): FilterText | null {
  if (!isRecord(v) || typeof v.text !== "string" || !v.text.trim() || v.text.length > TAB_FILTER_CAPS.text) return null;
  return switched({ text: v.text }, v.off === true);
}

/** The filters a tab kept; whatever is not shaped as one is dropped. */
export function readTabFilters(metadata: Record<string, unknown> | undefined): GridFilters {
  const kept = metadata?.[TAB_FILTERS_FIELD];
  if (!isRecord(kept)) return NO_FILTERS;
  const columns = isRecord(kept.columns)
    ? Object.entries(kept.columns)
      .slice(0, TAB_FILTER_CAPS.columns)
      .flatMap(([name, v]): [string, FilterText][] => {
        const f = keptText(v);
        return f && name && name.length <= TAB_FILTER_CAPS.name ? [[name, f]] : [];
      })
    : [];
  const multi = keptText(kept.multi);
  // Built from entries, so a column named `__proto__` is a column and not the object's prototype.
  return multi ? { columns: Object.fromEntries(columns), multi } : { columns: Object.fromEntries(columns) };
}

/** The tab's metadata with its filters kept in it; with none, no field is left behind. */
export function withTabFilters(metadata: Record<string, unknown> | undefined, filters: GridFilters): Record<string, unknown> {
  const { [TAB_FILTERS_FIELD]: _drop, ...rest } = metadata ?? {};
  return hasFilters(filters) ? { ...rest, [TAB_FILTERS_FIELD]: filters } : rest;
}

/** How "Filter multiple values" — and a paste of several lines — joins its lines. */
export type LinesMode = "is" | "isNot" | "contains" | "begins" | "ends";

const LINE_OPERATORS: Record<LinesMode, string> = { is: "=", isNot: "<>", contains: "", begins: "^", ends: "$" };

/**
 * One filter from a list of values, a line each, as DBGate writes it: every value quoted with
 * its own operator, joined with OR — or with AND for "is not one of", where OR would keep every
 * row. Blank lines are skipped; an empty result means there was nothing to filter by.
 */
export function linesFilter(mode: LinesMode, text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${LINE_OPERATORS[mode]}'${line.replaceAll("'", "''")}'`)
    .join(mode === "isNot" ? " " : ",");
}
