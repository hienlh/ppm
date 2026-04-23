import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import DataEditor, { type GridColumn, type Item } from "@glideapps/glide-data-grid";
import { Loader2 } from "lucide-react";
import type { GlideGridProps } from "./glide-grid-types";
import { useGlideTheme } from "./glide-grid-theme";
import { useGlideColumns } from "./use-glide-columns";
import { useGlideCellContent } from "./use-glide-cell-content";
import { useGlideSelection } from "./use-glide-selection";
import { useGlidePendingEdits } from "./use-glide-pending-edits";
import { useGlideRowPinning } from "./use-glide-row-pinning";
import { useGlideGridActions } from "./use-glide-grid-actions";
import { GlideHeaderMenu } from "./glide-header-menu";
import { GlideContextMenu } from "./glide-context-menu";
import { GlideGridToolbar } from "./glide-grid-toolbar";
import { GlideSaveBar } from "./glide-save-bar";
import { GlideGridPagination } from "./glide-grid-pagination";
import { GlideDataPreviewPanel } from "./glide-data-preview-panel";

const HEADER_ICONS: Record<string, (p: { fgColor: string }) => string> = {
  sortAsc: (p) => `<svg viewBox="0 0 16 16" fill="${p.fgColor}"><path d="M8 4l4 6H4z"/></svg>`,
  sortDesc: (p) => `<svg viewBox="0 0 16 16" fill="${p.fgColor}"><path d="M8 12l4-6H4z"/></svg>`,
  headerFk: () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-linecap="round"><path d="M6 4.5H4.5a2.5 2.5 0 000 5H6M10 4.5h1.5a2.5 2.5 0 010 5H10M5 7h6"/></svg>`,
};

/**
 * Glide Data Grid wrapper for PPM database viewers.
 * Shared by database-viewer (Postgres/MySQL) and sqlite-viewer.
 */
export function GlideDataGrid(props: GlideGridProps) {
  const {
    columns: rawColumnNames, rows, total, limit, schema, loading,
    page, onPageChange, onCellUpdate, onRowDelete, onBulkDelete, onInsertRow,
    orderBy, orderDir, onToggleSort, onClearSort, columnFilters = {}, onColumnFilter,
    connectionId, selectedTable, selectedSchema, connectionName,
  } = props;

  const theme = useGlideTheme();
  const gridRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const columnNames = useMemo(() => {
    const names = new Set(schema.map((s) => s.name));
    return rawColumnNames.filter((c) => names.has(c));
  }, [rawColumnNames, schema]);

  // State
  const [pinnedCols, setPinnedCols] = useState<Set<string>>(new Set());
  const [colWidths, setColWidths] = useState<Map<string, number>>(new Map());
  const [headerMenu, setHeaderMenu] = useState<{ colName: string; bounds: { x: number; y: number; width: number; height: number } } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; rowIdx: number; colIdx: number } | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [insertedRows, setInsertedRows] = useState<Record<string, unknown>[]>([]);

  const pkCol = useMemo(() => {
    return schema.find((c) => c.pk)?.name ?? schema.find((c) => c.name.toLowerCase() === "id")?.name ?? null;
  }, [schema]);

  // Row pinning (pinned rows frozen at bottom via freezeTrailingRows)
  const { effectiveRows, pinnedCount, pinnedPks, setPinnedPks } = useGlideRowPinning(rows, pkCol);

  // Merge rows: unpinned → inserted → pinned (pinned must be last for freezeTrailingRows)
  const allRows = useMemo(() => {
    if (pinnedCount === 0) return [...effectiveRows, ...insertedRows];
    const unpinned = effectiveRows.slice(0, effectiveRows.length - pinnedCount);
    const pinned = effectiveRows.slice(effectiveRows.length - pinnedCount);
    return [...unpinned, ...insertedRows, ...pinned];
  }, [effectiveRows, insertedRows, pinnedCount]);
  const displayRows = useMemo(() => {
    if (!searchTerm.trim()) return allRows;
    const term = searchTerm.toLowerCase();
    return allRows.filter((row) => columnNames.some((col) => String(row[col] ?? "").toLowerCase().includes(term)));
  }, [allRows, columnNames, searchTerm]);

  const frozenTrailingRows = useMemo(() => {
    if (pinnedCount === 0 || !pkCol) return 0;
    if (!searchTerm.trim()) return pinnedCount;
    return displayRows.filter((row) => pinnedPks.has(String(row[pkCol] ?? ""))).length;
  }, [pinnedCount, pkCol, searchTerm, displayRows, pinnedPks]);

  // Hooks
  const { pendingRef, addEdit, commitAll, discardAll, hasPending, pendingCount, committedRef } = useGlidePendingEdits(pkCol, onCellUpdate, onInsertRow);
  const { columns, freezeColumns, columnOrder } = useGlideColumns(schema, columnNames, pinnedCols, colWidths, displayRows, orderBy, orderDir);
  const { getCellContent, onCellEdited } = useGlideCellContent(displayRows, columnOrder, schema, pkCol, addEdit, pendingRef);
  const { gridSelection, onGridSelectionChange, selectedRowIndices, clearSelection } = useGlideSelection();
  const {
    previewData, setPreviewData, openRowPreview, openCellPreview, openPreviewInTab,
    handlePaste, getContextFk, isCellViewable, openFkTable,
  } = useGlideGridActions({ displayRows, columnOrder, schema, pkCol, connectionId, connectionName, selectedTable, selectedSchema, addEdit, gridSelection, containerRef });

  useEffect(() => {
    if (committedRef.current) { committedRef.current = false; discardAll(); setInsertedRows([]); }
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleColumnResize = useCallback((col: GridColumn, newSize: number) => {
    setColWidths((prev) => new Map(prev).set(col.id ?? col.title, newSize));
  }, []);
  const handleHeaderMenuClick = useCallback((colIdx: number, bounds: { x: number; y: number; width: number; height: number }) => {
    const colName = columnOrder[colIdx]; if (colName) setHeaderMenu({ colName, bounds });
  }, [columnOrder]);
  const handleCellContextMenu = useCallback(([colIdx, rowIdx]: Item, event: { preventDefault: () => void; localEventX: number; localEventY: number; bounds: { x: number; y: number } }) => {
    event.preventDefault();
    setContextMenu({ position: { x: event.bounds.x + event.localEventX, y: event.bounds.y + event.localEventY }, rowIdx, colIdx });
  }, []);
  const togglePinColumn = useCallback((colName: string) => {
    setPinnedCols((prev) => { const n = new Set(prev); if (n.has(colName)) n.delete(colName); else n.add(colName); return n; });
  }, []);
  const togglePinRow = useCallback((rowIdx: number) => {
    if (!pkCol) return;
    const row = displayRows[rowIdx]; if (!row) return;
    const pk = String(row[pkCol] ?? "");
    setPinnedPks((prev) => { const n = new Set(prev); if (n.has(pk)) n.delete(pk); else n.add(pk); return n; });
  }, [pkCol, displayRows, setPinnedPks]);
  const getRowThemeOverride = useCallback((rowIdx: number) => {
    if (pinnedPks.size === 0 || !pkCol) return undefined;
    const row = displayRows[rowIdx];
    if (row && pinnedPks.has(String(row[pkCol] ?? ""))) return { bgCell: theme.bgCellMedium ?? theme.bgHeader };
    return undefined;
  }, [pinnedPks, pkCol, displayRows, theme]);
  const handleBulkDelete = useCallback(() => {
    if (!pkCol || !onBulkDelete) return;
    onBulkDelete(pkCol, selectedRowIndices.map((i) => displayRows[i]?.[pkCol]).filter((v) => v != null));
    clearSelection();
  }, [pkCol, onBulkDelete, selectedRowIndices, displayRows, clearSelection]);

  const [colSearchOpen, setColSearchOpen] = useState(false);
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setPreviewData(null); setColSearchOpen(false); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && hasPending) { e.preventDefault(); commitAll(); }
    const tag = (e.target as HTMLElement)?.tagName;
    if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); setColSearchOpen(true); }
  }, [hasPending, commitAll]);
  const handleRowAppended = useCallback(() => {
    if (!pkCol || !onInsertRow) return;
    setInsertedRows((prev) => [...prev, { [pkCol]: `__new_${Date.now()}` }]);
  }, [pkCol, onInsertRow]);
  const handleColumnJump = useCallback((colName: string) => {
    const idx = columnOrder.indexOf(colName);
    if (idx >= 0 && gridRef.current?.scrollTo) gridRef.current.scrollTo(idx, 0);
  }, [columnOrder]);

  // Context menu derived state
  const contextRow = contextMenu ? displayRows[contextMenu.rowIdx] : null;
  const contextPk = contextRow && pkCol ? String(contextRow[pkCol] ?? "") : "";
  const contextColName = contextMenu ? columnOrder[contextMenu.colIdx] : null;
  const contextCellViewable = isCellViewable(contextRow ?? null, contextColName ?? null);
  const contextFk = getContextFk(contextColName ?? null);
  const contextCellValue = contextRow && contextColName ? contextRow[contextColName] : null;

  if (!columnNames.length) {
    return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
      {loading ? <Loader2 className="size-4 animate-spin" /> : "Select a table"}
    </div>;
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden relative" tabIndex={0} onKeyDown={handleKeyDown}>
      <GlideGridToolbar hasSelection={selectedRowIndices.length > 0} selectedCount={selectedRowIndices.length}
        onBulkDelete={onBulkDelete && pkCol ? handleBulkDelete : undefined}
        onInsertRow={onInsertRow && pkCol ? handleRowAppended : undefined}
        columns={columnNames} selectedRows={selectedRowIndices.map((i) => displayRows[i]!).filter(Boolean)} connectionName={connectionName}
        searchTerm={searchTerm} onSearchChange={setSearchTerm} onColumnJump={handleColumnJump}
        colSearchOpen={colSearchOpen} onColSearchChange={setColSearchOpen} />

      {loading && <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60"><Loader2 className="size-5 animate-spin text-primary" /></div>}

      <div className="flex-1 min-h-0">
        <DataEditor ref={gridRef} columns={columns} rows={displayRows.length}
          getCellContent={getCellContent} getCellsForSelection={true}
          onCellEdited={onCellEdited} onPaste={handlePaste}
          theme={theme} freezeColumns={freezeColumns} freezeTrailingRows={frozenTrailingRows}
          rowMarkers={pkCol ? "checkbox-visible" : "number"}
          gridSelection={gridSelection} onGridSelectionChange={onGridSelectionChange}
          onColumnResize={handleColumnResize as any}
          onHeaderMenuClick={handleHeaderMenuClick as any} onCellContextMenu={handleCellContextMenu as any}
          getRowThemeOverride={getRowThemeOverride as any}
          trailingRowOptions={onInsertRow && pkCol ? { sticky: true, tint: true } : undefined}
          onRowAppended={onInsertRow ? handleRowAppended : undefined}
          headerIcons={HEADER_ICONS} smoothScrollX smoothScrollY width="100%" height="100%" />
      </div>

      {hasPending && <GlideSaveBar pendingCount={pendingCount} onSave={commitAll} onDiscard={() => { discardAll(); setInsertedRows([]); }} />}
      {previewData && <GlideDataPreviewPanel data={previewData} onClose={() => setPreviewData(null)} onOpenInTab={openPreviewInTab} />}
      <GlideGridPagination total={total} page={page} totalPages={Math.ceil(total / limit) || 1} onPageChange={onPageChange} />

      {headerMenu && (
        <GlideHeaderMenu colName={headerMenu.colName} bounds={headerMenu.bounds}
          isPinned={pinnedCols.has(headerMenu.colName)} filterValue={columnFilters[headerMenu.colName] ?? ""}
          sortState={orderBy === headerMenu.colName ? (orderDir === "ASC" ? "asc" : "desc") : null}
          onFilter={(val) => { if (!onColumnFilter) return; const n = { ...columnFilters }; if (val) n[headerMenu.colName] = val; else delete n[headerMenu.colName]; onColumnFilter(n); }}
          onSort={() => { if (onToggleSort) onToggleSort(headerMenu.colName); }}
          onClearSort={onClearSort}
          onTogglePin={() => togglePinColumn(headerMenu.colName)} onClose={() => setHeaderMenu(null)} />
      )}

      {contextMenu && contextRow && (
        <GlideContextMenu position={contextMenu.position} isPinned={pinnedPks.has(contextPk)}
          onViewRow={() => openRowPreview(contextMenu.rowIdx)}
          onViewCell={contextCellViewable ? () => openCellPreview(contextMenu.rowIdx, contextMenu.colIdx) : undefined}
          onPinRow={() => togglePinRow(contextMenu.rowIdx)}
          onDeleteRow={() => { if (pkCol && onRowDelete && contextRow) onRowDelete(pkCol, contextRow[pkCol]); }}
          onOpenFkTable={contextFk && contextCellValue != null && connectionId ? () => openFkTable(contextFk, contextCellValue) : undefined}
          fkLabel={contextFk ? `Open ${contextFk.table}.${contextFk.column}` : undefined}
          onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}
