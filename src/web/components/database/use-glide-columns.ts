import { useMemo } from "react";
import type { GridColumn } from "@glideapps/glide-data-grid";
import type { GridColumnSchema } from "./glide-grid-types";

interface UseGlideColumnsResult {
  /** GridColumn definitions of the columns shown, in order. */
  columns: GridColumn[];
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
 * Build Glide Data Grid column definitions from schema: the columns not hidden, in the table's
 * order, at the width dragged on the header or else one estimated from the first rows. The titles
 * are drawn by `columnTitleDrawer`, which shows the sort.
 */
export function useGlideColumns(
  schema: GridColumnSchema[],
  columnNames: string[],
  hidden: ReadonlySet<string> | undefined,
  colWidths: Readonly<Record<string, number>>,
  rows: Record<string, unknown>[],
): UseGlideColumnsResult {
  const schemaMap = useMemo(() => new Map(schema.map((s) => [s.name, s])), [schema]);

  // String keys so a refetch handing back an equal-but-new schema/columns array
  // doesn't count as a change.
  const columnsKey = columnNames.join("|");
  const typesKey = schema.map((s) => `${s.name}:${s.type}`).join("|");
  const hasRows = rows.length > 0;

  // Measured once per table, from the first rows that arrive: re-measuring on
  // every fetch made sorting and loading more rows resize every column.
  const autoWidths = useMemo(() => {
    const widths = new Map<string, number>();
    for (const name of columnNames) {
      widths.set(name, estimateColWidth(name, rows, schemaMap.get(name)?.type ?? "text"));
    }
    return widths;
  }, [columnsKey, typesKey, hasRows]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    const ordered = hidden?.size ? columnNames.filter((c) => !hidden.has(c)) : columnNames;
    const columns: GridColumn[] = ordered.map((name) => {
      // Own keys only: a column called `constructor` or `toString` would otherwise read Object's.
      const width = (Object.hasOwn(colWidths, name) ? colWidths[name] : undefined) ?? autoWidths.get(name) ?? 100;
      // The menu button is HTML (`grid/grid-header-overlay.tsx`): Glide centres its own in the
      // whole header, which the filter row makes taller than the title it belongs to.
      return { title: name, id: name, width, hasMenu: false };
    });
    return { columns, columnOrder: ordered };
  }, [columnNames, hidden, colWidths, autoWidths]);
}
