import { useCallback, useRef } from "react";
import { GridCellKind, type EditListItem, type EditableGridCell, type GridCell, type Item } from "@glideapps/glide-data-grid";
import type { GridColumnSchema } from "./glide-grid-types";
import { formatCellValue, isAutoIncrement } from "./glide-grid-types";
import type { GridChangeColors } from "./glide-grid-theme";
import { NO_FIELD_TEXT, NULL_TEXT, formatBinary, isBinaryValue } from "./grid/cell-display";
import { cellId, isCellLocked, isNewRowId, type CellChange, type GridChangeset } from "./grid/grid-changeset";

/** Map DB type string to Glide cell kind */
export function dbTypeToKind(type: string): GridCellKind {
  const t = type.toLowerCase();
  if (/^(int|serial|bigint|smallint|tinyint|mediumint|year|float|double|decimal|numeric|real|money)/.test(t)) {
    return GridCellKind.Number;
  }
  if (/^bool/.test(t)) return GridCellKind.Boolean;
  return GridCellKind.Text;
}

/** Truncate display string for canvas rendering performance */
function truncateDisplay(val: string, max = 200): string {
  return val.length > max ? val.slice(0, max) + "…" : val;
}

/** DBGate draws NULL faded and slanted, so it never reads as the text "NULL". */
const NULL_THEME = { textDark: "#6b7280", baseFontStyle: "italic 12px" };

const NO_CELL: GridCell = { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false };

/** What an edited cell holds now; `undefined` when the edit is not one the grid takes. */
function editedValue(cell: EditableGridCell): unknown {
  // A text cleared is NULL, as it always was here.
  if (cell.kind === GridCellKind.Text) return cell.data === "" ? null : cell.data;
  if (cell.kind === GridCellKind.Number || cell.kind === GridCellKind.Boolean) return cell.data ?? null;
  return undefined;
}

interface UseGlideCellContentResult {
  getCellContent: (cell: Item) => GridCell;
  /** Every edit Glide makes — a typed value, a cleared selection — as one step of the change set. */
  onCellsEdited: (items: readonly EditListItem[]) => boolean;
}

/**
 * Provides getCellContent and onCellsEdited callbacks for Glide Data Grid.
 * Uses refs for rows/columnOrder to avoid stale closures in canvas render loop.
 * Cells show the change set: a changed value washed yellow, a new row's cells its own values, and
 * DBGate's (No Field) where nothing was put in one yet.
 */
export function useGlideCellContent(
  rows: Record<string, unknown>[],
  columnOrder: string[],
  schema: GridColumnSchema[],
  pkCol: string | null,
  edit: (changes: CellChange[]) => void,
  changesetRef: React.RefObject<GridChangeset>,
  colors: GridChangeColors,
  readOnly = false,
): UseGlideCellContentResult {
  // Read through a ref: getCellContent is stable (canvas render loop) and must
  // still see the current mode without being re-created.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // Same for the key column: it changes when the grid switches tables, or when
  // a cached page without a row key is replaced by a fetched one.
  const pkColRef = useRef(pkCol);
  pkColRef.current = pkCol;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const colOrderRef = useRef(columnOrder);
  colOrderRef.current = columnOrder;
  const colorsRef = useRef(colors);
  colorsRef.current = colors;
  const editRef = useRef(edit);
  editRef.current = edit;

  const schemaMap = useRef(new Map<string, GridColumnSchema>());
  schemaMap.current = new Map(schema.map((s) => [s.name, s]));

  const getCellContent = useCallback(([colIdx, rowIdx]: Item): GridCell => {
    const colName = colOrderRef.current[colIdx];
    const row = rowsRef.current[rowIdx];
    if (!colName || !row) return NO_CELL;

    const colSchema = schemaMap.current.get(colName);
    const kind = colSchema ? dbTypeToKind(colSchema.type) : GridCellKind.Text;
    const isPk = colSchema?.pk ?? false;
    const pk = pkColRef.current;
    const rowId = pk ? String(row[pk]) : null;
    const isNew = rowId !== null && isNewRowId(rowId);
    const cs = changesetRef.current;
    const pending = rowId !== null ? cs.cells.get(cellId(rowId, colName)) : undefined;
    const readonly = readOnlyRef.current || rowId === null
      || isCellLocked({ pk: isPk, autoIncrement: !!colSchema && isAutoIncrement(colSchema) }, rowId, cs);
    // A saved row's key cannot even be opened: it is what finds the row.
    const allowOverlay = !(isPk && !isNew);
    // A changed cell of a saved row is washed yellow; a new row's cells take the row's green.
    const tint = pending && !isNew ? { bgCell: colorsRef.current.edited } : undefined;
    // A new row holds only what was put in it: its key field is the grid's name for it.
    const val = pending ? pending.newVal : isNew ? undefined : row[colName];

    if (val === undefined || val === null) {
      const displayData = val === undefined ? NO_FIELD_TEXT : NULL_TEXT;
      const themeOverride = { ...NULL_THEME, ...tint };
      // A number column edits as a number, even from nothing.
      if (kind === GridCellKind.Number) {
        return { kind: GridCellKind.Number, data: undefined, displayData, allowOverlay: allowOverlay && !readonly, readonly, themeOverride };
      }
      return { kind: GridCellKind.Text, data: "", displayData, allowOverlay: allowOverlay && !readonly, readonly, themeOverride };
    }

    // Bytes: their size and first few bytes. They are not text, so they are not edited as text.
    if (isBinaryValue(val)) {
      const shown = formatBinary(val);
      return {
        kind: GridCellKind.Text, data: shown, displayData: shown, allowOverlay: false, readonly: true,
        themeOverride: { textDark: "#9ca3af", ...tint },
      };
    }

    // Number cells
    if (kind === GridCellKind.Number && typeof val === "number") {
      return {
        kind: GridCellKind.Number, data: val, displayData: String(val),
        allowOverlay, readonly, themeOverride: tint,
      };
    }

    // Boolean cells
    if (kind === GridCellKind.Boolean && typeof val === "boolean") {
      return { kind: GridCellKind.Boolean, data: val, readonly, allowOverlay: false, themeOverride: tint };
    }

    // Text cell
    const strVal = formatCellValue(val);
    return {
      kind: GridCellKind.Text, data: strVal, displayData: truncateDisplay(strVal),
      allowOverlay, readonly, themeOverride: tint,
    };
  }, [changesetRef]); // stable — reads from refs

  const onCellsEdited = useCallback((items: readonly EditListItem[]) => {
    if (readOnlyRef.current || !pkColRef.current) return true;
    const changes: CellChange[] = [];
    for (const { location: [colIdx, rowIdx], value } of items) {
      const column = colOrderRef.current[colIdx];
      const row = rowsRef.current[rowIdx];
      const parsed = editedValue(value);
      if (!column || !row || parsed === undefined) continue;
      changes.push({ row, column, value: parsed });
    }
    if (changes.length) editRef.current(changes);
    // Handled: Glide is not to report the same edits again one cell at a time.
    return true;
  }, []);

  return { getCellContent, onCellsEdited };
}
