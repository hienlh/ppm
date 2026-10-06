import { useCallback, useRef, useEffect } from "react";
import type { Item, GridSelection } from "@glideapps/glide-data-grid";
import type { GridColumnSchema } from "./glide-grid-types";
import type { DialectName } from "../../../shared/db-types";
import { quoteIdentifier, quoteLiteral } from "../../../shared/sql-identifiers";
import { openQueryTab, type DbTabPlace } from "./explorer/open-db-tabs";
import type { CellChange } from "./grid/grid-changeset";

interface UseGlideGridActionsParams {
  displayRows: Record<string, unknown>[];
  columnOrder: string[];
  schema: GridColumnSchema[];
  pkCol: string | null;
  /** Where the rows come from; a foreign key is followed there. */
  place?: DbTabPlace;
  selectedSchema?: string;
  dialect?: DialectName;
  /** Pasted cells, as one step; cells that cannot be changed are the caller's to leave out. */
  edit: (changes: CellChange[]) => void;
  /** Current grid selection — needed for document-level paste */
  gridSelection?: GridSelection;
  /** Container ref — paste only fires when focus is inside */
  containerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Extracts the paste handler and FK navigation logic
 * from the main GlideDataGrid component to keep it under 200 lines.
 */
export function useGlideGridActions(params: UseGlideGridActionsParams) {
  const { displayRows, columnOrder, schema, pkCol, place, selectedSchema, dialect = "postgres", edit, gridSelection, containerRef } = params;

  // Refs to avoid stale closures in canvas callbacks
  const displayRowsRef = useRef(displayRows);
  displayRowsRef.current = displayRows;
  const columnOrderRef = useRef(columnOrder);
  columnOrderRef.current = columnOrder;

  // Custom paste handler — pasted TSV cells become one edit
  const handlePaste = useCallback((target: Item, values: readonly (readonly string[])[]) => {
    if (!pkCol) return false;
    edit(pastedCells(target, values, displayRowsRef.current, columnOrderRef.current));
    return false; // we handled it
  }, [pkCol, edit]);

  // Document-level paste listener — works even when Glide canvas doesn't have focus
  const gridSelRef = useRef(gridSelection);
  gridSelRef.current = gridSelection;
  const editRef = useRef(edit);
  editRef.current = edit;
  const pkColRef = useRef(pkCol);
  pkColRef.current = pkCol;

  useEffect(() => {
    if (!containerRef) return;
    const handler = (e: ClipboardEvent) => {
      const container = containerRef.current;
      if (!container || !container.contains(document.activeElement)) return;
      // Skip if an input/textarea is focused (e.g. search bar)
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const pk = pkColRef.current;
      if (!pk) return;
      const sel = gridSelRef.current?.current;
      if (!sel) return; // need a selected cell as paste anchor
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      const tsvRows = text.split(/\r?\n/).filter((r) => r.length > 0).map((r) => r.split("\t"));
      if (tsvRows.length === 0) return;
      editRef.current(pastedCells(sel.cell, tsvRows, displayRowsRef.current, columnOrderRef.current));
      e.preventDefault();
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [containerRef]);

  // FK detection helpers for context menu
  const getContextFk = useCallback((colName: string | null) => {
    if (!colName) return null;
    return schema.find((s) => s.name === colName)?.fk ?? null;
  }, [schema]);

  // FK navigation: the referenced row, read by a Query tab that runs its SELECT on open. The
  // reference names no schema, so it is looked up in the one the grid shows.
  const openFkTable = useCallback((fk: { table: string; column: string }, cellValue: unknown) => {
    if (cellValue == null || !place) return;
    const table = selectedSchema
      ? `${quoteIdentifier(selectedSchema, dialect)}.${quoteIdentifier(fk.table, dialect)}`
      : quoteIdentifier(fk.table, dialect);
    openQueryTab(place, `SELECT * FROM ${table} WHERE ${quoteIdentifier(fk.column, dialect)} = ${quoteLiteral(String(cellValue), dialect)}`, { run: true });
  }, [place, selectedSchema, dialect]);

  return { handlePaste, getContextFk, openFkTable };
}

/** The cells a paste at `target` lands on, an empty text being NULL; past the last row or column, nothing. */
function pastedCells(
  target: Item, values: readonly (readonly string[])[], rows: readonly Record<string, unknown>[], columns: readonly string[],
): CellChange[] {
  const [startCol, startRow] = target;
  const changes: CellChange[] = [];
  values.forEach((line, r) => {
    const row = rows[startRow + r];
    if (!row) return;
    line.forEach((raw, c) => {
      const column = columns[startCol + c];
      if (column) changes.push({ row, column, value: raw === "" ? null : raw });
    });
  });
  return changes;
}
