/**
 * A foreign key followed by its values: the filter a table's box would hold to show exactly the
 * rows the values name, and what that filter asks the server for. Written as ⋮ writes a picked
 * value (`="5"`) and read back in the column's own syntax, so a number column compares numbers
 * and a date column that one second — the server is never handed a raw value to compare.
 */
import type { ColumnKind } from "../../../../shared/db-column-kind";
import { parseFilter } from "../../../../shared/db-filter-parser";
import type { FilterGroup } from "../../../../shared/db-grid";
import { isBinaryValue } from "./cell-display";
import { NO_FILTERS, withColumnFilter, type GridFilters } from "./grid-filters";
import { pickedValuesFilter, valueKey, valueTerm } from "./value-filter-text";

/**
 * The values a key is filtered by, each once: no NULL, which references nothing, and no bytes,
 * which no filter can spell.
 */
export function keyValues(values: readonly unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const value of values) {
    if (value === null || value === undefined || isBinaryValue(value)) continue;
    const key = valueKey(value);
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()];
}

/** `="5",="7"` on `column`, and the group it asks for; null when there is no value to filter by. */
export function keyValuesFilter(
  column: string, kind: ColumnKind, values: readonly unknown[],
): { text: string; group: FilterGroup } | null {
  const usable = keyValues(values);
  if (!usable.length) return null;
  const text = pickedValuesFilter(kind, usable);
  const read = parseFilter(text, kind);
  if (!read.ok || read.anyOf.length === 0) return null;
  return { text, group: { column, anyOf: read.anyOf } };
}

/**
 * The filters the form button on a foreign key cell opens the referenced table on: its key column
 * equal to the cell's value, written in the key's own syntax as ⋮ writes a picked value — the key
 * and what it refers to share a type. Null when the value refers to nothing.
 */
export function referencedRowFilters(keyColumn: string, kind: ColumnKind, value: unknown): GridFilters | null {
  if (value === null || value === undefined || isBinaryValue(value)) return null;
  return withColumnFilter(NO_FILTERS, keyColumn, valueTerm(kind, value));
}
