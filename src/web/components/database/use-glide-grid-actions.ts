import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTabStore } from "@/stores/tab-store";
import type { Item, GridSelection } from "@glideapps/glide-data-grid";
import type { GridColumnSchema } from "./glide-grid-types";
import { needsViewer } from "./glide-grid-types";
import { resolvePreviewData, rowPk, type PreviewSource } from "./resolve-preview-data";

interface UseGlideGridActionsParams {
  displayRows: Record<string, unknown>[];
  columnOrder: string[];
  schema: GridColumnSchema[];
  pkCol: string | null;
  connectionId?: number;
  connectionName?: string;
  selectedTable?: string | null;
  selectedSchema?: string;
  addEdit: (pkVal: unknown, col: string, newVal: unknown) => void;
  /** Current grid selection — needed for document-level paste */
  gridSelection?: GridSelection;
  /** Container ref — paste only fires when focus is inside */
  containerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Extracts preview panel, paste handler, and FK navigation logic
 * from the main GlideDataGrid component to keep it under 200 lines.
 */
export function useGlideGridActions(params: UseGlideGridActionsParams) {
  const { displayRows, columnOrder, schema, pkCol, connectionId, connectionName, selectedTable, selectedSchema, addEdit, gridSelection, containerRef } = params;
  const { openTab } = useTabStore(useShallow((s) => ({ openTab: s.openTab })));
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null);

  // Refs to avoid stale closures in canvas callbacks
  const displayRowsRef = useRef(displayRows);
  displayRowsRef.current = displayRows;
  const columnOrderRef = useRef(columnOrder);
  columnOrderRef.current = columnOrder;

  // Preview panel — inline Monaco viewer for cell/row content
  const rowPkOf = useCallback((row: Record<string, unknown>) => rowPk(row, pkCol), [pkCol]);

  const openRowPreview = useCallback((rowIdx: number) => {
    const row = displayRows[rowIdx]; if (!row) return;
    setPreviewSource({ kind: "row", rowIdx, pk: rowPkOf(row) });
  }, [displayRows, rowPkOf]);

  const openCellPreview = useCallback((rowIdx: number, colIdx: number) => {
    const row = displayRows[rowIdx]; if (!row) return;
    const colName = columnOrder[colIdx]; if (!colName) return;
    setPreviewSource({ kind: "cell", rowIdx, pk: rowPkOf(row), colName });
  }, [displayRows, columnOrder, rowPkOf]);

  const closePreview = useCallback(() => setPreviewSource(null), []);

  // Derived from current rows so a table reload refreshes the open preview
  const previewData = useMemo(
    () => resolvePreviewData(previewSource, { displayRows, pkCol, selectedTable, connectionId }),
    [previewSource, displayRows, pkCol, selectedTable, connectionId],
  );

  const openPreviewInTab = useCallback(() => {
    if (!previewData) return;
    openTab({ type: "editor", title: previewData.title, projectId: null, closable: true,
      metadata: { inlineContent: previewData.content, inlineLanguage: previewData.language, viewerKey: previewData.viewerKey } });
  }, [openTab, previewData]);

  // Custom paste handler — routes pasted TSV cells through addEdit
  const handlePaste = useCallback((target: Item, values: readonly (readonly string[])[]) => {
    if (!pkCol) return false;
    const [startCol, startRow] = target;
    for (let r = 0; r < values.length; r++) {
      const row = displayRowsRef.current[startRow + r];
      if (!row) continue;
      const pk = row[pkCol];
      for (let c = 0; c < values[r]!.length; c++) {
        const colName = columnOrderRef.current[startCol + c];
        if (!colName) continue;
        const colDef = schema.find((s) => s.name === colName);
        if (colDef?.pk) continue;
        const raw = values[r]![c]!;
        addEdit(pk, colName, raw === "" ? null : raw);
      }
    }
    return false; // we handled it
  }, [pkCol, schema, addEdit]);

  // Document-level paste listener — works even when Glide canvas doesn't have focus
  const schemaRef = useRef(schema);
  schemaRef.current = schema;
  const gridSelRef = useRef(gridSelection);
  gridSelRef.current = gridSelection;
  const addEditRef = useRef(addEdit);
  addEditRef.current = addEdit;
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
      const [startCol, startRow] = sel.cell;
      for (let r = 0; r < tsvRows.length; r++) {
        const row = displayRowsRef.current[startRow + r];
        if (!row) continue;
        const rowPk = row[pk];
        for (let c = 0; c < tsvRows[r]!.length; c++) {
          const colName = columnOrderRef.current[startCol + c];
          if (!colName) continue;
          const colDef = schemaRef.current.find((s) => s.name === colName);
          if (colDef?.pk) continue;
          const raw = tsvRows[r]![c]!;
          addEditRef.current(rowPk, colName, raw === "" ? null : raw);
        }
      }
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

  const isCellViewable = useCallback((row: Record<string, unknown> | null, colName: string | null) => {
    return row && colName ? needsViewer(row[colName]) : false;
  }, []);

  // FK navigation: open referenced table in new tab filtered by FK value
  const openFkTable = useCallback((fk: { table: string; column: string }, cellValue: unknown) => {
    if (cellValue == null || !connectionId) return;
    openTab({
      type: "database",
      title: `${connectionName ?? "DB"} · ${fk.table}`,
      projectId: null,
      closable: true,
      metadata: {
        connectionId, connectionName,
        tableName: fk.table,
        schemaName: selectedSchema ?? "public",
        initialSql: `SELECT * FROM "${fk.table}" WHERE "${fk.column}" = '${String(cellValue).replace(/'/g, "''")}'`,
      },
    });
  }, [connectionId, connectionName, selectedSchema, openTab]);

  return {
    previewData, closePreview,
    openRowPreview, openCellPreview, openPreviewInTab,
    handlePaste, getContextFk, isCellViewable, openFkTable,
  };
}
