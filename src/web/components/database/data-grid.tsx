import { useState, useCallback, useMemo, useRef, memo, useEffect } from "react";
import { Loader2, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Trash2, Plus, Search, X, Eye, Filter, Pin, PinOff, Columns3 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useTabStore } from "@/stores/tab-store";
import type { DbColumnInfo } from "./use-database";
import { ExportButton } from "./export-button";

interface DataGridProps {
  tableData: { columns: string[]; rows: Record<string, unknown>[]; total: number; limit: number } | null;
  schema: DbColumnInfo[];
  loading: boolean;
  page: number;
  onPageChange: (p: number) => void;
  onCellUpdate: (pkCol: string, pkVal: unknown, col: string, val: unknown) => void;
  onRowDelete?: (pkCol: string, pkVal: unknown) => void;
  orderBy: string | null;
  orderDir: "ASC" | "DESC";
  onToggleSort: (column: string) => void;
  onBulkDelete?: (pkColumn: string, pkValues: unknown[]) => void;
  onInsertRow?: (values: Record<string, unknown>) => Promise<void>;
  connectionId?: number;
  selectedTable?: string | null;
  selectedSchema?: string;
  connectionName?: string;
  /** Controlled column ILIKE filters — parent owns state */
  columnFilters?: Record<string, string>;
  /** Called when column ILIKE filters change — parent builds WHERE clause */
  onColumnFilter?: (filters: Record<string, string>) => void;
}

export function DataGrid({
  tableData, schema, loading, page, onPageChange, onCellUpdate, onRowDelete,
  orderBy, orderDir, onToggleSort,
  onBulkDelete, onInsertRow,
  connectionId, selectedTable, selectedSchema, connectionName, columnFilters: colFilters = {}, onColumnFilter,
}: DataGridProps) {
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);
  const [globalFilter, setGlobalFilter] = useState("");
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [insertMode, setInsertMode] = useState(false);
  const [insertValues, setInsertValues] = useState<Record<string, string>>({});
  const [insertError, setInsertError] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const { openTab } = useTabStore(useShallow((s) => ({ openTab: s.openTab })));
  const openCellViewer = useCallback((cell: { col: string; value: string }) => {
    openTab({
      type: "editor",
      title: cell.col,
      projectId: null,
      closable: true,
      metadata: { inlineContent: cell.value, inlineLanguage: detectLang(cell.value) },
    });
  }, [openTab]);
  const [pinnedCols, setPinnedCols] = useState<Set<string>>(new Set());
  const [pinnedRows, setPinnedRows] = useState<Set<number>>(new Set());
  const [filterOpenCol, setFilterOpenCol] = useState<string | null>(null);
  const [colSearchOpen, setColSearchOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pkCol = useMemo(() => {
    const explicit = schema.find((c) => c.pk)?.name;
    if (explicit) return explicit;
    const idCol = schema.find((c) => c.name.toLowerCase() === "id");
    return idCol?.name ?? null;
  }, [schema]);

  const openRowViewer = useCallback((row: Record<string, unknown>) => {
    const json = JSON.stringify(row, null, 2);
    const pk = pkCol ? String(row[pkCol] ?? "") : "";
    openTab({
      type: "editor",
      title: pk ? `Row ${pk}` : "Row",
      projectId: null,
      closable: true,
      metadata: { inlineContent: json, inlineLanguage: "json" },
    });
  }, [openTab, pkCol]);

  // Refs for cell renderers — avoid column memo rebuild on every state change
  const editingRef = useRef(editingCell);
  editingRef.current = editingCell;
  const editValueRef = useRef(editValue);
  editValueRef.current = editValue;
  const selectedRowsRef = useRef(selectedRows);
  selectedRowsRef.current = selectedRows;
  const confirmDeleteRef = useRef(confirmDeleteIdx);
  confirmDeleteRef.current = confirmDeleteIdx;

  const startEdit = useCallback((rowIdx: number, col: string, val: unknown) => {
    setEditingCell({ rowIdx, col });
    if (val == null) setEditValue("");
    else if (typeof val === "object") setEditValue(JSON.stringify(val));
    else setEditValue(String(val));
  }, []);

  const commitEdit = useCallback(() => {
    const ec = editingRef.current;
    if (!ec || !tableData || !pkCol) return;
    const row = tableData.rows[ec.rowIdx];
    if (!row) return;
    const oldVal = row[ec.col];
    if (String(oldVal ?? "") !== editValueRef.current) {
      onCellUpdate(pkCol, row[pkCol], ec.col, editValueRef.current === "" ? null : editValueRef.current);
    }
    setEditingCell(null);
  }, [tableData, pkCol, onCellUpdate]);

  const cancelEdit = useCallback(() => setEditingCell(null), []);

  const handleDelete = useCallback((rowIdx: number) => {
    if (!tableData || !pkCol || !onRowDelete) return;
    const row = tableData.rows[rowIdx];
    if (!row) return;
    onRowDelete(pkCol, row[pkCol]);
    setConfirmDeleteIdx(null);
  }, [tableData, pkCol, onRowDelete]);

  const togglePinCol = useCallback((col: string) => {
    setPinnedCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col); else next.add(col);
      return next;
    });
  }, []);

  const togglePinRow = useCallback((idx: number) => {
    setPinnedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  const updateColFilter = useCallback((col: string, val: string) => {
    const next = { ...colFilters };
    if (val) next[col] = val; else delete next[col];
    onColumnFilter?.(next);
  }, [colFilters, onColumnFilter]);

  const toggleRowSelection = useCallback((idx: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  const toggleAllRows = useCallback(() => {
    if (!tableData) return;
    setSelectedRows((prev) => {
      if (prev.size === tableData.rows.length) return new Set();
      return new Set(tableData.rows.map((_, i) => i));
    });
  }, [tableData]);

  const handleBulkDelete = useCallback(() => {
    if (!tableData || !pkCol || !onBulkDelete) return;
    const pkValues = Array.from(selectedRows).map((idx) => tableData.rows[idx]?.[pkCol]).filter((v) => v != null);
    onBulkDelete(pkCol, pkValues);
    setSelectedRows(new Set());
    setConfirmBulkDelete(false);
  }, [tableData, pkCol, onBulkDelete, selectedRows]);

  const handleInsertSave = useCallback(async () => {
    if (!onInsertRow) return;
    setInsertError(null);
    try {
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(insertValues)) {
        if (v !== "") values[k] = v;
      }
      await onInsertRow(values);
      setInsertMode(false);
      setInsertValues({});
    } catch (e) {
      setInsertError((e as Error).message);
    }
  }, [onInsertRow, insertValues]);

  // Filter rows by global filter (simple client-side text match)
  const filteredRows = useMemo(() => {
    if (!tableData || !globalFilter) return tableData?.rows ?? [];
    const lf = globalFilter.toLowerCase();
    return tableData.rows.filter((row) =>
      tableData.columns.some((col) => String(row[col] ?? "").toLowerCase().includes(lf))
    );
  }, [tableData, globalFilter]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Cmd/Ctrl+A → select all, Cmd/Ctrl+C → copy selected as TSV (Excel-compatible)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      // Escape closes column search from anywhere
      if (e.key === "Escape") { setColSearchOpen(false); return; }

      // Skip if focus is in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // "/" → open column jump (like VSCode list filter)
      if (e.key === "/") {
        e.preventDefault();
        setColSearchOpen(true);
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !tableData) return;

      if (e.key === "a") {
        e.preventDefault();
        setSelectedRows(new Set(tableData.rows.map((_, i) => i)));
      }
      if (e.key === "c" && selectedRows.size > 0) {
        e.preventDefault();
        const cols = tableData.columns;
        const header = cols.join("\t");
        const rows = Array.from(selectedRows)
          .sort((a, b) => a - b)
          .map((i) => cols.map((c) => {
            const v = tableData.rows[i]?.[c];
            if (v == null) return "";
            if (typeof v === "object") return JSON.stringify(v);
            return String(v);
          }).join("\t"));
        navigator.clipboard.writeText([header, ...rows].join("\n"));
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [tableData, selectedRows]);

  // Build ordered column list: pinned first, then unpinned
  const orderedCols = useMemo(() => {
    if (!tableData) return [];
    const pinned = tableData.columns.filter((c) => pinnedCols.has(c));
    const unpinned = tableData.columns.filter((c) => !pinnedCols.has(c));
    return [...pinned, ...unpinned];
  }, [tableData?.columns, pinnedCols]);

  // Measure actual column widths and header height from DOM
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [colWidths, setColWidths] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    const thead = theadRef.current;
    if (!thead) return;
    const measure = () => {
      setHeaderHeight(thead.offsetHeight);
      const widths = new Map<string, number>();
      thead.querySelectorAll<HTMLElement>("th[data-col]").forEach((th) => {
        widths.set(th.dataset.col!, th.offsetWidth);
      });
      const cbTh = thead.querySelector<HTMLElement>("th[data-col='_cb']");
      if (cbTh) widths.set("_cb", cbTh.offsetWidth);
      setColWidths(widths);
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(thead);
    return () => obs.disconnect();
  }, [tableData?.columns, pinnedCols]);

  // Compute sticky left offsets from measured widths
  const pinnedColOffsets = useMemo(() => {
    const offsets = new Map<string, number>();
    let left = colWidths.get("_cb") ?? (pkCol ? 40 : 0);
    for (const col of orderedCols) {
      if (!pinnedCols.has(col)) break;
      offsets.set(col, left);
      left += colWidths.get(col) ?? 100;
    }
    return offsets;
  }, [orderedCols, pinnedCols, pkCol, colWidths]);

  // Separate pinned rows to render them sticky at top
  const pinnedRowData = useMemo(() =>
    Array.from(pinnedRows).sort((a, b) => a - b).map((i) => ({ idx: i, row: filteredRows[i]! })).filter((r) => r.row),
  [pinnedRows, filteredRows]);

  // Measure pinned row heights from DOM for accurate sticky offsets
  const pinnedRowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const [pinnedRowHeights, setPinnedRowHeights] = useState<Map<number, number>>(new Map());

  const setPinnedRowRef = useCallback((idx: number, el: HTMLTableRowElement | null) => {
    if (el) pinnedRowRefs.current.set(idx, el);
    else pinnedRowRefs.current.delete(idx);
  }, []);

  useEffect(() => {
    if (pinnedRowData.length === 0) {
      if (pinnedRowHeights.size > 0) setPinnedRowHeights(new Map());
      return;
    }
    const id = requestAnimationFrame(() => {
      const heights = new Map<number, number>();
      for (const { idx } of pinnedRowData) {
        const el = pinnedRowRefs.current.get(idx);
        if (el) heights.set(idx, el.offsetHeight);
      }
      setPinnedRowHeights(heights);
    });
    return () => cancelAnimationFrame(id);
  }, [pinnedRowData, tableData]); // eslint-disable-line react-hooks/exhaustive-deps

  const pinnedRowTops = useMemo(() => {
    const tops = new Map<number, number>();
    let cumTop = headerHeight;
    for (const { idx } of pinnedRowData) {
      tops.set(idx, cumTop);
      cumTop += pinnedRowHeights.get(idx) ?? 28;
    }
    return tops;
  }, [headerHeight, pinnedRowData, pinnedRowHeights]);

  const jumpToColumn = useCallback((col: string) => {
    const container = scrollRef.current;
    const th = container?.querySelector<HTMLElement>(`th[data-col="${col}"]`);
    if (!container || !th) return;
    // Calculate sticky left offset (checkbox + pinned columns)
    let stickyWidth = 0;
    const cbTh = container.querySelector<HTMLElement>(`th[data-col="_cb"]`);
    if (cbTh) stickyWidth += cbTh.offsetWidth;
    for (const [pc, offset] of pinnedColOffsets) {
      if (pc !== col) stickyWidth = Math.max(stickyWidth, offset + (colWidths.get(pc) ?? 0));
    }
    const targetLeft = th.offsetLeft - stickyWidth;
    container.scrollTo({ left: targetLeft, behavior: "instant" });
    setColSearchOpen(false);
  }, [pinnedColOffsets, colWidths]);

  if (!tableData) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        {loading ? <Loader2 className="size-4 animate-spin" /> : "Select a table"}
      </div>
    );
  }

  const totalPages = Math.ceil(tableData.total / tableData.limit) || 1;
  const hasSelection = selectedRows.size > 0;
  const allSelected = selectedRows.size === tableData.rows.length && tableData.rows.length > 0;

  return (
    <div ref={containerRef} tabIndex={0} className="flex flex-col h-full overflow-hidden outline-none">
      {/* Search + bulk actions toolbar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-background shrink-0">
        <div className="flex items-center gap-1 flex-1">
          <Search className="size-3 text-muted-foreground" />
          <input type="text" value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search current page…"
            className="flex-1 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground" />
          {globalFilter && (
            <button type="button" onClick={() => setGlobalFilter("")} className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          )}
        </div>

        {/* Column jump */}
        <div className="relative">
          <button type="button" onClick={() => setColSearchOpen(!colSearchOpen)}
            className={`p-0.5 rounded transition-colors ${colSearchOpen ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
            title="Jump to column ( / )">
            <Columns3 className="size-3.5" />
          </button>
          {colSearchOpen && (
            <ColumnSearchDropdown columns={tableData.columns}
              onSelect={jumpToColumn}
              onClose={() => setColSearchOpen(false)} />
          )}
        </div>

        {hasSelection && (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">{selectedRows.size} selected</span>
            {onBulkDelete && pkCol && (
              confirmBulkDelete ? (
                <span className="flex items-center gap-1">
                  <button type="button" onClick={handleBulkDelete} className="text-destructive text-[10px] font-medium hover:underline">
                    Delete {selectedRows.size}?
                  </button>
                  <button type="button" onClick={() => setConfirmBulkDelete(false)} className="text-muted-foreground text-[10px] hover:underline">Cancel</button>
                </span>
              ) : (
                <button type="button" onClick={() => setConfirmBulkDelete(true)} className="p-0.5 text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-3" />
                </button>
              )
            )}
            <ExportButton
              columns={tableData.columns}
              rows={Array.from(selectedRows).map((i) => tableData.rows[i]!).filter(Boolean)}
              filename={`${connectionName ?? "db"}-selected`}
            />
          </div>
        )}

        {onInsertRow && (
          <button type="button" onClick={() => { setInsertMode(true); setInsertValues({}); setInsertError(null); }}
            className="p-0.5 rounded text-muted-foreground hover:text-primary transition-colors" title="Insert row">
            <Plus className="size-3.5" />
          </button>
        )}
      </div>

      {/* Insert row form */}
      {insertMode && (
        <div className="px-2 py-1.5 border-b border-border bg-muted/30 text-xs space-y-1">
          <div className="flex flex-wrap gap-1.5">
            {schema.filter((c) => !c.pk).map((col) => (
              <div key={col.name} className="flex items-center gap-1">
                <label className="text-muted-foreground text-[10px] w-16 truncate" title={col.name}>{col.name}</label>
                <input value={insertValues[col.name] ?? ""}
                  onChange={(e) => setInsertValues((prev) => ({ ...prev, [col.name]: e.target.value }))}
                  placeholder={col.defaultValue ?? (col.nullable ? "NULL" : "")}
                  className="h-5 w-24 text-[11px] px-1 rounded border border-border bg-background outline-none focus:border-primary" />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={handleInsertSave} className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90">Save</button>
            <button type="button" onClick={() => setInsertMode(false)} className="text-[10px] text-muted-foreground hover:underline">Cancel</button>
            {insertError && <span className="text-[10px] text-destructive">{insertError}</span>}
          </div>
        </div>
      )}

      {/* Table */}
      <div ref={scrollRef} className="flex-1 overflow-auto relative">
        {loading && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        )}
        <table className="w-full text-xs" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
          <thead ref={theadRef} className="sticky top-0 z-20 bg-muted">
            <tr>
              {pkCol && (
                <th data-col="_cb" className="px-2 py-1.5 text-left font-medium text-muted-foreground border-b border-border w-10 bg-muted"
                  style={{ position: "sticky", left: 0, zIndex: 30 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAllRows} className="size-3 accent-primary" />
                </th>
              )}
              {orderedCols.map((col) => {
                const isPk = schema.find((c) => c.name === col)?.pk;
                const isSorted = orderBy === col;
                const isPinned = pinnedCols.has(col);
                const hasFilter = !!colFilters[col];
                const isFilterOpen = filterOpenCol === col;
                const stickyLeft = pinnedColOffsets.get(col);
                return (
                  <th key={col} data-col={col}
                    className={`group/th px-2 py-1.5 text-left font-medium text-muted-foreground border-b border-border whitespace-nowrap bg-muted ${isPinned ? "border-r border-r-primary/20" : ""}`}
                    style={stickyLeft != null ? { position: "sticky", left: stickyLeft, zIndex: 25 } : undefined}>
                    <div className="flex items-center gap-0.5">
                      <button type="button" onClick={() => onToggleSort(col)}
                        className={`flex items-center gap-0.5 ${isPk ? "font-bold" : ""} hover:text-foreground transition-colors`}>
                        {col}
                        {isSorted && orderDir === "ASC" && <ChevronUp className="size-3" />}
                        {isSorted && orderDir === "DESC" && <ChevronDown className="size-3" />}
                      </button>
                      {/* Filter button */}
                      {onColumnFilter && (
                        <button type="button" title="Filter column"
                          onClick={() => setFilterOpenCol(isFilterOpen ? null : col)}
                          className={`p-0.5 rounded transition-colors ${hasFilter || isFilterOpen ? "text-primary" : "text-muted-foreground/40 md:opacity-0 md:group-hover/th:opacity-100 hover:text-foreground"}`}>
                          <Filter className="size-2.5" />
                        </button>
                      )}
                      {/* Pin column button */}
                      <button type="button" title={isPinned ? "Unpin column" : "Pin column"}
                        onClick={() => togglePinCol(col)}
                        className={`p-0.5 rounded transition-colors ${isPinned ? "text-primary" : "text-muted-foreground/40 md:opacity-0 md:group-hover/th:opacity-100 hover:text-foreground"}`}>
                        {isPinned ? <PinOff className="size-2.5" /> : <Pin className="size-2.5" />}
                      </button>
                    </div>
                    {/* Inline filter input */}
                    {isFilterOpen && (
                      <div className="mt-1 flex items-center gap-1">
                        <input autoFocus type="text" value={colFilters[col] ?? ""} placeholder="ILIKE filter…"
                          onChange={(e) => updateColFilter(col, e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Escape") setFilterOpenCol(null); }}
                          className="w-full h-5 text-[10px] px-1 rounded border border-border bg-background outline-none focus:border-primary" />
                        {hasFilter && (
                          <button type="button" onClick={() => updateColFilter(col, "")} className="text-muted-foreground hover:text-foreground">
                            <X className="size-2.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </th>
                );
              })}
              {onRowDelete && pkCol && <th className="px-2 py-1.5 border-b border-border w-14 bg-muted" />}
            </tr>
          </thead>
          <tbody>
            {/* Pinned rows — sticky at top below header */}
            {pinnedRowData.map(({ idx, row }) => (
              <DataRow key={`pin-${idx}`} row={row} rowIdx={idx} columns={orderedCols}
                selected={selectedRows.has(idx)} onToggleSelect={toggleRowSelection}
                pkCol={pkCol} editingCell={editingCell} editValue={editValue}
                onStartEdit={startEdit} onCommitEdit={commitEdit} onCancelEdit={cancelEdit}
                onSetEditValue={setEditValue} showDelete={!!onRowDelete}
                confirmingDelete={confirmDeleteIdx === idx}
                onDelete={handleDelete} onConfirmDelete={setConfirmDeleteIdx}
                onViewCell={openCellViewer} onViewRow={openRowViewer}
                pinned onTogglePin={togglePinRow}
                pinnedCols={pinnedCols} pinnedColOffsets={pinnedColOffsets}
                stickyTop={pinnedRowTops.get(idx) ?? headerHeight}
                trRef={(el) => setPinnedRowRef(idx, el)} />
            ))}
            {/* Normal rows */}
            {filteredRows.map((row, rowIdx) => {
              if (pinnedRows.has(rowIdx)) return null; // skip pinned — rendered above
              return (
                <DataRow key={rowIdx} row={row} rowIdx={rowIdx} columns={orderedCols}
                  selected={selectedRows.has(rowIdx)} onToggleSelect={toggleRowSelection}
                  pkCol={pkCol} editingCell={editingCell} editValue={editValue}
                  onStartEdit={startEdit} onCommitEdit={commitEdit} onCancelEdit={cancelEdit}
                  onSetEditValue={setEditValue} showDelete={!!onRowDelete}
                  confirmingDelete={confirmDeleteIdx === rowIdx}
                  onDelete={handleDelete} onConfirmDelete={setConfirmDeleteIdx}
                  onViewCell={openCellViewer} onViewRow={openRowViewer}
                  pinned={false} onTogglePin={togglePinRow}
                  pinnedCols={pinnedCols} pinnedColOffsets={pinnedColOffsets} />
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={orderedCols.length + 2} className="px-2 py-8 text-center text-muted-foreground">No data</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: row count + pagination */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-background shrink-0 text-xs text-muted-foreground">
        <span>{tableData.total.toLocaleString()} rows</span>
        {/* Shortcut hints — desktop only */}
        <div className="hidden md:flex items-center gap-2 text-[10px] text-muted-foreground/50">
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">/</kbd> columns</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">{"\u2318"}A</kbd> select all</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">{"\u2318"}C</kbd> copy</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
            <ChevronLeft className="size-3.5" />
          </button>
          <span>{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>

    </div>
  );
}

/** Format cell value — JSON-stringify objects/arrays, otherwise String() */
function formatCellValue(val: unknown): string {
  if (val == null) return "NULL";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/** Large data threshold (200 bytes) or structured data (json object/array, xml-like) */
const LARGE_THRESHOLD = 200;
function needsViewer(val: unknown): boolean {
  if (val == null) return false;
  if (typeof val === "object") return true; // json/jsonb column
  const s = String(val);
  if (s.length >= LARGE_THRESHOLD) return true;
  // Detect JSON string or XML string
  const trimmed = s.trimStart();
  if ((trimmed[0] === "{" || trimmed[0] === "[") && (trimmed.endsWith("}") || trimmed.endsWith("]"))) return true;
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<") && trimmed.endsWith(">")) return true;
  return false;
}

/** Detect language from content for syntax highlighting */
function detectLang(text: string): string {
  const t = text.trimStart();
  if (t[0] === "{" || t[0] === "[") {
    try { JSON.parse(t); return "json"; } catch { /* not json */ }
  }
  if (t.startsWith("<?xml") || (t.startsWith("<") && /<\/\w+>/.test(t))) return "xml";
  if (t.startsWith("---") || /^\w+:\s/m.test(t)) return "yaml";
  return "plaintext";
}

/** Column search dropdown — owns query/index state internally to avoid re-rendering DataGrid */
function ColumnSearchDropdown({ columns, onSelect, onClose }: {
  columns: string[]; onSelect: (col: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const filtered = useMemo(() => {
    if (!query) return columns;
    const lq = query.toLowerCase();
    return columns.filter((c) => c.toLowerCase().includes(lq));
  }, [columns, query]);

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [idx]);

  return (
    <div className="absolute top-full right-0 mt-1 z-50 w-52 max-h-56 bg-popover border border-border rounded-md shadow-lg overflow-hidden flex flex-col">
      <input autoFocus type="text" value={query}
        onChange={(e) => { setQuery(e.target.value); setIdx(0); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && filtered[idx]) onSelect(filtered[idx]);
        }}
        placeholder="Search columns…"
        className="px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border text-foreground placeholder:text-muted-foreground" />
      <div className="overflow-auto flex-1">
        {filtered.map((col, i) => (
          <button key={col} type="button" onClick={() => onSelect(col)}
            ref={i === idx ? activeRef : undefined}
            className={`w-full text-left px-2 py-1 text-xs truncate ${i === idx ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"}`}>
            {col}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Memoized row — only re-renders when its own props change */
const DataRow = memo(function DataRow({ row, rowIdx, columns, selected, onToggleSelect, pkCol,
  editingCell, editValue, onStartEdit, onCommitEdit, onCancelEdit, onSetEditValue,
  showDelete, confirmingDelete, onDelete, onConfirmDelete, onViewCell, onViewRow,
  pinned, onTogglePin, pinnedCols, pinnedColOffsets, stickyTop, trRef,
}: {
  row: Record<string, unknown>; rowIdx: number; columns: string[];
  selected: boolean; onToggleSelect: (i: number) => void;
  pkCol: string | null;
  editingCell: { rowIdx: number; col: string } | null; editValue: string;
  onStartEdit: (i: number, col: string, val: unknown) => void;
  onCommitEdit: () => void; onCancelEdit: () => void;
  onSetEditValue: (v: string) => void;
  showDelete: boolean; confirmingDelete: boolean;
  onDelete: (i: number) => void; onConfirmDelete: (i: number | null) => void;
  onViewCell: (cell: { col: string; value: string }) => void;
  onViewRow: (row: Record<string, unknown>) => void;
  pinned: boolean; onTogglePin: (i: number) => void;
  pinnedCols: Set<string>; pinnedColOffsets: Map<string, number>;
  stickyTop?: number;
  trRef?: (el: HTMLTableRowElement | null) => void;
}) {
  // Opaque bg required for sticky cells to cover content underneath
  const cellBg = pinned ? "bg-muted" : selected ? "bg-primary/5" : "bg-background";
  return (
    <tr ref={trRef} className={`group ${pinned ? "" : "hover:bg-muted/30"}`}
      style={pinned ? { position: "sticky", top: stickyTop, zIndex: 15 } : undefined}>
      {pkCol && (
        <td className={`px-2 py-1 border-b border-border/50 ${cellBg}`}
          style={{ position: "sticky", left: 0, zIndex: 12 }}>
          <span className="flex items-center gap-0.5">
            <input type="checkbox" checked={selected} onChange={() => onToggleSelect(rowIdx)} className="size-3 accent-primary" />
            <button type="button" title="View row as JSON" onClick={() => onViewRow(row)}
              className="p-0.5 rounded transition-colors text-muted-foreground/30 md:opacity-0 md:group-hover:opacity-100 hover:text-foreground">
              <Eye className="size-2.5" />
            </button>
            <button type="button" title={pinned ? "Unpin row" : "Pin row"} onClick={() => onTogglePin(rowIdx)}
              className={`p-0.5 rounded transition-colors ${pinned ? "text-primary" : "text-muted-foreground/30 md:opacity-0 md:group-hover:opacity-100 hover:text-foreground"}`}>
              {pinned ? <PinOff className="size-2.5" /> : <Pin className="size-2.5" />}
            </button>
          </span>
        </td>
      )}
      {columns.map((col) => {
        const isEditing = editingCell?.rowIdx === rowIdx && editingCell?.col === col;
        const val = row[col];
        const showEye = !isEditing && needsViewer(val);
        const isColPinned = pinnedCols.has(col);
        const stickyLeft = pinnedColOffsets.get(col);
        const needsBg = isColPinned || pinned;
        return (
          <td key={col}
            className={`px-2 py-1 max-w-[300px] border-b border-border/50 ${isColPinned ? "border-r border-r-primary/20" : ""} ${needsBg ? cellBg : ""}`}
            style={stickyLeft != null ? { position: "sticky", left: stickyLeft, zIndex: 10 } : undefined}>
            {isEditing ? (
              <input autoFocus className="w-full bg-transparent border border-primary/50 rounded px-1 py-0 text-xs outline-none"
                value={editValue} onChange={(e) => onSetEditValue(e.target.value)}
                onBlur={onCommitEdit} onKeyDown={(e) => { if (e.key === "Enter") onCommitEdit(); if (e.key === "Escape") onCancelEdit(); }} />
            ) : (
              <span className="flex items-center gap-0.5">
                <span className={`cursor-pointer truncate flex-1 ${val == null ? "text-muted-foreground/40 italic" : ""}`}
                  onDoubleClick={() => pkCol && onStartEdit(rowIdx, col, val)} title={formatCellValue(val)}>
                  {formatCellValue(val)}
                </span>
                {showEye && (
                  <button type="button" title="View full content"
                    onClick={() => onViewCell({ col, value: formatCellValue(val) })}
                    className="shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-foreground transition-colors">
                    <Eye className="size-3" />
                  </button>
                )}
              </span>
            )}
          </td>
        );
      })}
      {showDelete && pkCol && (
        <td className={`px-2 py-1 border-b border-border/50 ${pinned ? cellBg : ""}`}>
          {confirmingDelete ? (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <button type="button" onClick={() => onDelete(rowIdx)} className="text-destructive text-[10px] font-medium hover:underline">Confirm</button>
              <button type="button" onClick={() => onConfirmDelete(null)} className="text-muted-foreground text-[10px] hover:underline">Cancel</button>
            </span>
          ) : (
            <button type="button" onClick={() => onConfirmDelete(rowIdx)}
              className="p-0.5 rounded md:opacity-0 md:group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity" title="Delete row">
              <Trash2 className="size-3" />
            </button>
          )}
        </td>
      )}
    </tr>
  );
});
