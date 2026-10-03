/**
 * Where ⋮ and ⋯ get what they list, for one table view. ⋮ reads the column's values from
 * `POST grid/values` under the other filters in force. ⋯ reads the table a foreign key references
 * — its columns from `GET schema`, its rows from its own `POST grid` — in the schema of the table
 * the key is on, since the key names no other.
 */
import { useCallback, useMemo } from "react";
import { api } from "@/lib/api-client";
import { targetKey, targetUrl, type DbTarget } from "@/lib/db-tabs";
import { useSettingsStore } from "@/stores/settings-store";
import type { FilterableColumn } from "../../../../shared/db-filter-parser";
import { rowsToRecords, type FilterGroup, type GridResponse, type GridValuesResponse } from "../../../../shared/db-grid";
import type { DbType } from "../../../../shared/db-types";
import type { GridColumnSchema } from "../glide-grid-types";
import type { FilterBoxDialog } from "./filter-dialog-host";
import { filterableColumns, type GridFilters } from "./grid-filters";
import { lookupRowsRequest, valuesRequest } from "./value-filter-text";

/** The key a table's lookup Description is remembered under. */
export function lookupTableKey(target: DbTarget | null, schema: string, table: string): string {
  return `${targetKey(target)}:${encodeURIComponent(schema)}:${encodeURIComponent(table)}`;
}

export function useFilterPickers({ target, dbType, table, schema, columns, tableSchema, filters, fixed }: {
  target: DbTarget | null;
  dbType: DbType | undefined;
  table: string;
  /** Empty for the connection's own. */
  schema: string;
  /** How every column of the table reads a filter. */
  columns: readonly FilterableColumn[];
  /** The table's columns as read, with their foreign keys. */
  tableSchema: readonly GridColumnSchema[];
  filters: GridFilters;
  /** What the rows are filtered by besides the boxes — the key a reference under a grid follows — which ⋮ lists within. */
  fixed?: readonly FilterGroup[];
}) {
  const at = useCallback((path: string) => (target ? targetUrl(target, path) : ""), [target]);
  const kindOf = useCallback((column: string) => columns.find((c) => c.name === column)?.kind ?? "other", [columns]);

  /** ⋮ on `column`. */
  const chooseValues = useCallback((column: string): FilterBoxDialog => ({
    dialog: "values",
    column,
    kind: kindOf(column),
    load: (search) => {
      const request = valuesRequest({ table, schema }, column, search, filters, columns);
      return api.post<GridValuesResponse>(at("/grid/values"), fixed?.length ? { ...request, filters: [...fixed, ...(request.filters ?? [])] } : request);
    },
  }), [at, kindOf, table, schema, filters, columns, fixed]);

  /** ⋯ on `column`; null when it is not a foreign key. */
  const lookup = useCallback((column: string): FilterBoxDialog | null => {
    const fk = tableSchema.find((c) => c.name === column)?.fk;
    if (!fk) return null;
    const key = lookupTableKey(target, schema, fk.table);
    const schemaParam = schema ? `&schema=${encodeURIComponent(schema)}` : "";
    return {
      dialog: "lookup",
      kind: kindOf(column),
      source: {
        table: fk.table,
        keyColumn: fk.column,
        columns: () => api.get<GridColumnSchema[]>(at(`/schema?table=${encodeURIComponent(fk.table)}${schemaParam}`))
          .then((read) => filterableColumns(read, dbType)),
        rows: (anyColumn) => api.post<GridResponse>(at("/grid"), lookupRowsRequest({ table: fk.table, schema }, fk.column, anyColumn))
          .then((page) => ({ rows: rowsToRecords(page.columns, page.rows).records, hasMore: page.hasMore })),
        description: useSettingsStore.getState().dbLookupDescriptions[key] ?? null,
        onDescription: (chosen) => useSettingsStore.getState().setDbLookupDescription(key, chosen),
      },
    };
  }, [at, kindOf, target, dbType, schema, tableSchema]);

  // The grid redraws every filter box when this changes.
  return useMemo(() => ({ chooseValues, lookup }), [chooseValues, lookup]);
}
