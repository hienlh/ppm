import { useCallback, useRef } from "react";
import { GridCellKind, type GridCell, type EditableGridCell, type Item } from "@glideapps/glide-data-grid";
import type { GridColumnSchema } from "./glide-grid-types";
import { formatCellValue } from "./glide-grid-types";
import type { PendingEdit } from "./use-glide-pending-edits";

/** Map DB type string to Glide cell kind */
function dbTypeToKind(type: string): GridCellKind {
  const t = type.toLowerCase();
  if (/^(int|serial|bigint|smallint|float|double|decimal|numeric|real|money)/.test(t)) {
    return GridCellKind.Number;
  }
  if (/^bool/.test(t)) return GridCellKind.Boolean;
  return GridCellKind.Text;
}

/** Check if a PK column is auto-increment (serial, identity, nextval default) */
function isAutoIncrement(col: GridColumnSchema): boolean {
  const t = col.type.toLowerCase();
  if (/^(serial|bigserial|smallserial)/.test(t)) return true;
  if (/^(int|bigint|smallint|integer)/.test(t) && col.defaultValue && /nextval|identity|auto_increment/i.test(col.defaultValue)) return true;
  // SQLite: INTEGER PRIMARY KEY is auto-increment by default
  if (t === "integer" && col.pk && !col.defaultValue) return true;
  return false;
}

/** Truncate display string for canvas rendering performance */
function truncateDisplay(val: string, max = 200): string {
  return val.length > max ? val.slice(0, max) + "…" : val;
}

/** Amber background for cells with pending unsaved edits */
const PENDING_THEME = { bgCell: "rgba(251, 191, 36, 0.15)" };

interface UseGlideCellContentResult {
  getCellContent: (cell: Item) => GridCell;
  onCellEdited: (cell: Item, newValue: EditableGridCell) => void;
}

/**
 * Provides getCellContent and onCellEdited callbacks for Glide Data Grid.
 * Uses refs for rows/columnOrder to avoid stale closures in canvas render loop.
 * Integrates with pending edits — shows pending values with amber highlight.
 */
export function useGlideCellContent(
  rows: Record<string, unknown>[],
  columnOrder: string[],
  schema: GridColumnSchema[],
  pkCol: string | null,
  addPendingEdit: (pkVal: unknown, col: string, newVal: unknown) => void,
  pendingRef: React.RefObject<Map<string, PendingEdit>>,
): UseGlideCellContentResult {
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const colOrderRef = useRef(columnOrder);
  colOrderRef.current = columnOrder;

  const schemaMap = useRef(new Map<string, GridColumnSchema>());
  schemaMap.current = new Map(schema.map((s) => [s.name, s]));

  const getCellContent = useCallback(([colIdx, rowIdx]: Item): GridCell => {
    const colName = colOrderRef.current[colIdx];
    const row = rowsRef.current[rowIdx];
    if (!colName || !row) {
      return { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false };
    }

    const colSchema = schemaMap.current.get(colName);
    const kind = colSchema ? dbTypeToKind(colSchema.type) : GridCellKind.Text;
    const isPk = colSchema?.pk ?? false;

    // Check for pending edit value
    const pkVal = pkCol ? row[pkCol] : undefined;
    const isNewRow = typeof pkVal === "string" && pkVal.startsWith("__new_");
    const pendingKey = `${pkVal}:${colName}`;
    const pending = pendingRef.current.get(pendingKey);
    const val = pending !== undefined ? pending.newVal : row[colName];
    const hasPending = pending !== undefined;

    // New row PK column — auto-increment PKs show "NEW" (readonly), text PKs are editable
    if (isPk && isNewRow) {
      const isAuto = colSchema ? isAutoIncrement(colSchema) : false;
      if (isAuto) {
        return { kind: GridCellKind.Text, data: "", displayData: "AUTO", allowOverlay: false, readonly: true,
          themeOverride: { textDark: "#6b7280" } };
      }
      // Editable PK (text, uuid, etc.) — show pending value or placeholder
      const editedVal = pending !== undefined ? String(pending.newVal ?? "") : "";
      return { kind: GridCellKind.Text, data: editedVal, displayData: editedVal || "Enter ID…",
        allowOverlay: true, readonly: false,
        themeOverride: editedVal ? (hasPending ? PENDING_THEME : undefined) : { textDark: "#9ca3af" } };
    }

    // NULL values — for new rows show default/type hints
    if (val == null) {
      let placeholder = isNewRow ? "" : "NULL";
      if (isNewRow && !hasPending && colSchema) {
        const t = colSchema.type.toLowerCase();
        if (colSchema.defaultValue) {
          placeholder = colSchema.defaultValue;
        } else if (/^(timestamp|datetime|date)/.test(t)) {
          placeholder = "NOW()";
        } else if (/^(uuid)/.test(t)) {
          placeholder = "gen_random_uuid()";
        }
      }
      return {
        kind: GridCellKind.Text, data: "", displayData: placeholder,
        allowOverlay: !isPk, readonly: isPk,
        themeOverride: hasPending ? PENDING_THEME : (isNewRow || placeholder !== "NULL" ? { textDark: "#9ca3af" } : { textDark: "#6b7280" }),
      };
    }

    // Number cells
    if (kind === GridCellKind.Number && typeof val === "number") {
      return {
        kind: GridCellKind.Number, data: val, displayData: String(val),
        allowOverlay: !isPk, readonly: isPk,
        themeOverride: hasPending ? PENDING_THEME : undefined,
      };
    }

    // Boolean cells
    if (kind === GridCellKind.Boolean && typeof val === "boolean") {
      return { kind: GridCellKind.Boolean, data: val, readonly: isPk, allowOverlay: false };
    }

    // Text cell
    const strVal = formatCellValue(val);
    return {
      kind: GridCellKind.Text, data: strVal, displayData: truncateDisplay(strVal),
      allowOverlay: !isPk, readonly: isPk,
      themeOverride: hasPending ? PENDING_THEME : undefined,
    };
  }, []); // stable — reads from refs

  const onCellEdited = useCallback(([colIdx, rowIdx]: Item, newValue: EditableGridCell) => {
    if (!pkCol) return;
    const colName = colOrderRef.current[colIdx];
    const row = rowsRef.current[rowIdx];
    if (!colName || !row) return;

    const pkVal = row[pkCol];
    let parsed: unknown;
    if (newValue.kind === GridCellKind.Text) {
      parsed = newValue.data === "" ? null : newValue.data;
    } else if (newValue.kind === GridCellKind.Number) {
      parsed = newValue.data;
    } else if (newValue.kind === GridCellKind.Boolean) {
      parsed = newValue.data;
    } else {
      return;
    }

    addPendingEdit(pkVal, colName, parsed);
  }, [pkCol, addPendingEdit]);

  return { getCellContent, onCellEdited };
}
