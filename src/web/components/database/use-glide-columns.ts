import { useMemo } from "react";
import type { GridColumn } from "@glideapps/glide-data-grid";
import type { GridColumnSchema } from "./glide-grid-types";

interface UseGlideColumnsResult {
  /** Ordered GridColumn definitions (pinned first) */
  columns: GridColumn[];
  /** Number of frozen columns from left */
  freezeColumns: number;
  /** Column name order matching GridColumn indices */
  columnOrder: string[];
}

/** Estimate column width from header name and sample row values */
function estimateColWidth(name: string, rows: Record<string, unknown>[], type: string): number {
  const headerW = name.length * 9 + 40; // header text + sort icon + menu icon padding
  let maxContentW = 0;
  const sampleCount = Math.min(rows.length, 20);
  for (let i = 0; i < sampleCount; i++) {
    const val = rows[i]?.[name];
    if (val == null) continue;
    const len = typeof val === "object" ? 12 : String(val).length;
    maxContentW = Math.max(maxContentW, len * 8);
  }
  const isNumeric = /^(int|serial|bigint|smallint|float|double|decimal|numeric|real|money|bool)/.test(type.toLowerCase());
  const minW = isNumeric ? 80 : 100;
  return Math.max(minW, Math.min(Math.max(headerW, maxContentW) + 16, 400));
}

/**
 * Build Glide Data Grid column definitions from schema.
 * Reorders columns: pinned first, then unpinned. Auto-sizes widths.
 */
export function useGlideColumns(
  schema: GridColumnSchema[],
  columnNames: string[],
  pinnedCols: Set<string>,
  colWidths: Map<string, number>,
  rows: Record<string, unknown>[],
  orderBy?: string | null,
  orderDir?: "ASC" | "DESC",
): UseGlideColumnsResult {
  const schemaMap = useMemo(() => new Map(schema.map((s) => [s.name, s])), [schema]);

  // String keys so a refetch handing back an equal-but-new schema/columns array
  // doesn't count as a change.
  const columnsKey = columnNames.join("|");
  const typesKey = schema.map((s) => `${s.name}:${s.type}`).join("|");
  const hasRows = rows.length > 0;

  // Measured once per table, from the first page that arrives: re-measuring on
  // every fetch made sorting and paging resize every column.
  const autoWidths = useMemo(() => {
    const widths = new Map<string, number>();
    for (const name of columnNames) {
      widths.set(name, estimateColWidth(name, rows, schemaMap.get(name)?.type ?? "text"));
    }
    return widths;
  }, [columnsKey, typesKey, hasRows]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    const pinned = columnNames.filter((c) => pinnedCols.has(c));
    const unpinned = columnNames.filter((c) => !pinnedCols.has(c));
    const ordered = [...pinned, ...unpinned];

    const columns: GridColumn[] = ordered.map((name) => {
      const col = schemaMap.get(name);
      const isPk = col?.pk ?? false;

      let icon: string | undefined;
      if (orderBy === name) {
        icon = orderDir === "ASC" ? "sortAsc" : "sortDesc";
      } else if (isPk) {
        icon = "headerRowID";
      } else if (col?.fk) {
        icon = "headerFk";
      }

      const width = colWidths.get(name) ?? autoWidths.get(name) ?? 100;
      return { title: name, id: name, width, hasMenu: true, icon };
    });

    return { columns, freezeColumns: pinned.length, columnOrder: ordered };
  }, [schemaMap, columnNames, pinnedCols, colWidths, autoWidths, orderBy, orderDir]);
}
