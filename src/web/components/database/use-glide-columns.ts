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
  return useMemo(() => {
    const pinned = columnNames.filter((c) => pinnedCols.has(c));
    const unpinned = columnNames.filter((c) => !pinnedCols.has(c));
    const ordered = [...pinned, ...unpinned];

    const schemaMap = new Map(schema.map((s) => [s.name, s]));

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

      const width = colWidths.get(name) ?? estimateColWidth(name, rows, col?.type ?? "text");
      return { title: name, id: name, width, hasMenu: true, icon };
    });

    return { columns, freezeColumns: pinned.length, columnOrder: ordered };
  }, [schema, columnNames, pinnedCols, colWidths, rows, orderBy, orderDir]);
}
