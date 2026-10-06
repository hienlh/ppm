/**
 * Glide Data Grid wrapper for PPM's database tabs: a table's data and a query's results, as DBGate
 * shows them. A title selects its column, a row number its row; a column's ⌄ opens its menu, which
 * is where it is sorted. A table's rows arrive 100 at a time: scrolling to the last one read asks
 * for the next ones. Rows / Count / Sum of the selection sit in the bottom-right corner; "Rows: N"
 * of the table is the tab's, in PPM's status bar (db-rows-status.tsx).
 *
 * Changes wait in DBGate's change set until Save (grid/use-changeset.ts): edited cells washed
 * yellow, new rows green under the rows read, rows to delete red and struck through — every step
 * undone with Ctrl+Z and redone with Ctrl+Y. On a desktop F4 shows the current row as DBGate's form
 * instead (grid/form-view.tsx), editing the same change set; a phone opens it in a sheet.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import DataEditor, {
  CompactSelection, type CellClickedEventArgs, type DataEditorRef, type DrawCellCallback, type GridCell, type GridColumn, type GridMouseEventArgs,
  type Item, type Rectangle, type Theme,
} from "@glideapps/glide-data-grid";
import { toast } from "sonner";
import {
  ArrowNext, ArrowPrevious, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, Filter,
  Info, ListFilter, Loader2, Redo2, RefreshCw, RotateCcw, Save, TableSimple, Undo2, XCircle,
} from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { triggerDownload } from "@/lib/file-download";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { formatCombo } from "@/stores/keybindings-store";
import { setUnsavedGridRows } from "@/stores/unsaved-grid-rows-store";
import { GridHeaderOverlay, type GridHeaderOverlayHandle, type OverlayColumn } from "./grid/grid-header-overlay";
import { FilterCell } from "./grid/filter-row";
import { columnFilterCellProps } from "./grid/column-filter-cell";
import { FILTER_BAND, TITLE_BAND, TITLE_BAND_TOUCH, TITLE_SPRITES, columnTitleDrawer, rowMarkerWidth, titleIcon, type TitleColumn } from "./grid/header-bands";
import { sortPosition } from "./grid/column-menu";
import { loadMoreDecision } from "./grid/load-more";
import { forEachSelectedCell, selectedBlock, selectionHasCell, selectionStats } from "./grid/selection-stats";
import { GridCornerLabel, GridLoadingBox, GridSelectionStats } from "./grid/grid-status-bar";
import { drawBesideFkButton, drawFkButton, isOnFkButton } from "./grid/fk-cell-button";
import {
  EMPTY_CHANGESET, addRows, cellId, cloneValues, deleteRows, isCellLocked, isNewRowId, revertRows, toGridChanges,
  type CellChange, type LockColumn,
} from "./grid/grid-changeset";
import { useChangeset } from "./grid/use-changeset";
import { cellMark, drawCellMark, rowChange, rowChangeTheme } from "./grid/change-marks";
import { isBinaryValue } from "./grid/cell-display";
import { cellEditor } from "./grid/cell-editor";
import { fkCellEditor } from "./grid/fk-cell-editor";
import { DictionaryLookupDialog } from "./grid/dictionary-lookup-dialog";
import { RowFormSheet } from "./grid/row-form-sheet";
import { FormView, fieldKind, type FormMenuTarget } from "./grid/form-view";
import { formCopyText, navigateFormRow, parseFormText, type FormNavigation } from "./grid/form-view-model";
import { canChooseValues } from "./grid/value-filter-text";
import { NO_FILTERS, withColumnFilter } from "./grid/grid-filters";
import { cellFile, cellFileBase, cellFileName, selectedColumnIndices, selectedValueFilters, type CellFile } from "./grid/selection-commands";
import { documentChanges, newRowValues, readJsonDocuments, rowDocumentText, type DocumentColumn } from "./grid/json-document";
import { TextValueDialog } from "./grid/text-value-dialog";
import { GenerateSqlDialog } from "./grid/generate-sql-dialog";
import type { SqlSourceRow } from "./grid/generate-sql";
import type { CopySqlTarget } from "./grid/copy-as";
import { isGridKeyCommand, isTextField, tableKeyCommand, tableKeyPlace, type GridKeyCommand } from "./grid/table-keys";
import { isGridSurface, useGridCopy, type GridCopySource } from "./grid/use-grid-copy";
import { cellMenuEntries, summarizeSelection, type CellMenuEntry, type CellMenuSelection } from "./grid/cell-menu";
import { GRID_EXPORT_FORMATS, gridExportDownloadUrl } from "../../../shared/db-grid-export";
import { CellContextMenu } from "./grid/cell-context-menu";
import { useCellLongPress, type CellPoint } from "./grid/use-cell-long-press";
import { classifyColumnType } from "../../../shared/db-column-kind";
import { formatCellValue, isAutoIncrement, rowKeyOf, type GlideGridHandle, type GlideGridProps } from "./glide-grid-types";
import { useGlideTheme, useGridChangeColors } from "./glide-grid-theme";
import { useGlideColumns } from "./use-glide-columns";
import { useGlideCellContent } from "./use-glide-cell-content";
import { useGlideSelection } from "./use-glide-selection";
import { useGlideGridActions } from "./use-glide-grid-actions";
import { GlideHeaderMenu } from "./glide-header-menu";
import { GlideContextMenu, type GridMenuEntry } from "./glide-context-menu";
import { GlideSaveBar } from "./glide-save-bar";
import { CellDataPanel, CellDataSheet, keepCellDataWidth, readCellDataWidth, type CellDataSource } from "./grid/cell-data-panel";
import { NO_CELL_DATA, cellText, collectCellData, type CellDataChoice } from "./grid/cell-data-formats";

/** Swallows edits (paste, context-menu actions) while the grid is read-only. */
const NOOP_EDIT = () => {};

/** DBGate's editors in a dialog: Edit cell value, Edit row as JSON document and Add JSON document. */
type TextDialog =
  | { kind: "cell"; row: Record<string, unknown>; column: string; initial: string }
  | { kind: "row"; row: Record<string, unknown>; initial: string }
  | { kind: "add" };

/** Save cell to file's download, typed as bytes whatever they hold, so that no browser opens it as a page. */
function downloadCellFile(file: Extract<CellFile, { ok: true }>) {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: "application/octet-stream" }));
  try {
    triggerDownload(url, file.name);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Puts the keys in the grid or the form under `root` with `focus` — which answers whether they are
 * there — now or once there is something to take them: Glide puts its canvas in only once its
 * scroller has been measured, a few frames after the editor mounts, and focus asked for before then
 * goes nowhere. Given up once the user has put the keys anywhere else, and by the cleanup it answers.
 */
function focusOnceDrawn(root: Element, focus: () => boolean): () => void {
  const from = document.activeElement;
  const moved = () => !!document.activeElement && document.activeElement !== from && document.activeElement !== document.body;
  const done = () => moved() || focus();
  if (done()) return () => {};
  const watch = new MutationObserver(() => { if (done()) watch.disconnect(); });
  watch.observe(root, { childList: true, subtree: true });
  return () => watch.disconnect();
}

/**
 * Puts the keys back with `refocus` when what held them under `root` leaves the page — the cell Glide
 * focuses, gone with its row: a new row undone, deleted or reverted. Chrome drops them on the body,
 * and Glide takes them back only while it holds them. The removal is heard from the DOM, not from a
 * focusout, which a browser need not send for a node taken away. Never once the user has put the
 * keys anywhere else.
 */
function keepKeysOnRemoval(root: Element, refocus: () => void): () => void {
  let held: Element | null = null;
  const check = () => {
    if (!held || held.isConnected) return;
    held = null;
    if (!document.activeElement || document.activeElement === document.body) refocus();
  };
  const onIn = (e: Event) => { held = e.target as Element; };
  // Still on the page once the event is over: the keys were moved, not dropped.
  const onOut = (e: Event) => {
    const left = e.target as Element;
    queueMicrotask(() => { if (left === held && left.isConnected) held = null; });
  };
  const watch = new MutationObserver(check);
  root.addEventListener("focusin", onIn);
  root.addEventListener("focusout", onOut);
  watch.observe(root, { childList: true, subtree: true });
  return () => {
    watch.disconnect();
    root.removeEventListener("focusin", onIn);
    root.removeEventListener("focusout", onOut);
  };
}

/**
 * DBGate's ways into a cell's editor: Glide's own, and F2. Copy is the grid's own (grid/use-grid-copy.ts),
 * in the format Set format chose, and so is cut: Glide's would clear the cells without copying them.
 */
const KEYBINDINGS = { activateCell: " |Enter|shift+Enter|F2", copy: false, cut: false };

/**
 * Hidden field holding a key of several columns as one value, so rows are
 * still told apart by a single field (pending edits, previews). Not
 * enumerable, so a row preview or an export never shows it.
 */
const ROW_ID = "__ppm_row_id";

/**
 * The grid's scrollbars, which run the full height and width of the grid: what is laid over the
 * header has to stop short of the vertical one, what sits at the foot above the horizontal one.
 * Zero where scrollbars overlay the content, and while everything fits.
 */
function useScrollbarSize(container: RefObject<HTMLElement | null>, rowCount: number, columnCount: number, gridShown: boolean) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const scroller = gridShown ? container.current?.querySelector<HTMLElement>(".dvn-scroller") : null;
    if (!scroller) {
      setSize((s) => (s.width === 0 && s.height === 0 ? s : { width: 0, height: 0 }));
      return;
    }
    const measure = () => {
      const width = scroller.offsetWidth - scroller.clientWidth;
      const height = scroller.offsetHeight - scroller.clientHeight;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [container, rowCount, columnCount, gridShown]);
  return size;
}

const readCssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const GlideDataGrid = forwardRef<GlideGridHandle, GlideGridProps>(function GlideDataGrid(props, ref) {
  const {
    columns: rawColumnNames, rows, schema, loading, onSaveChanges, rowKey, editOnly,
    sort = [], onSortChange, viewKey, hasMore = false, onLoadMore, loadingMore = false, fetchingAll = null,
    hiddenColumns, onShowAllColumns, onHideColumns, onFindColumn, columnWidths, onColumnWidthsChange, onEditStateChange,
    sidePanel, onResetFilter, onOpenQuery, onOpenGeneratedSql, exporter, startCellDownload, focusOnVisible, onOpenTable, filtering, lookupFor,
    place, selectedTable, selectedSchema, dialect, readOnly, tabId, tabSlot, onSelectedRowsChange, rowsLabel,
    view = "table", onViewChange, formNameFilter = "", onFormNameFilterChange, rowCount = null, onFetchAll,
    loadReference, onOpenReference, onFilterValue, onAddToFilter, onRefresh, floatCellData = false,
  } = props;

  const theme = useGlideTheme();
  const colors = useGridChangeColors(theme);
  const gridRef = useRef<DataEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const columnNames = useMemo(() => {
    const names = new Set(schema.map((s) => s.name));
    return rawColumnNames.filter((c) => names.has(c));
  }, [rawColumnNames, schema]);
  const schemaMap = useMemo(() => new Map(schema.map((s) => [s.name, s])), [schema]);

  const [headerMenu, setHeaderMenu] = useState<{ colName: string; bounds: { x: number; y: number; width: number; height: number } } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; rowIdx: number; colIdx: number } | null>(null);
  // The row a phone has open as a form (grid/row-form-sheet.tsx), by its place among the rows shown.
  const [formRow, setFormRow] = useState<number | null>(null);
  // DBGate's Form view in place of the grid, on a desktop: a phone's form is that sheet.
  const mobile = useIsMobile();
  const formView = view === "form" && !mobile;

  // The columns that address a row. A grid saving changesets is told them; a read-only one guesses
  // one — the primary key, else `id` — which a row preview finds its row again by.
  const batch = !!onSaveChanges;
  const keyCols = useMemo(() => {
    if (batch) return rowKey ?? [];
    const guess = schema.find((c) => c.pk)?.name ?? schema.find((c) => c.name.toLowerCase() === "id")?.name;
    return guess ? [guess] : [];
  }, [batch, rowKey, schema]);
  const pkCol = keyCols.length > 1 ? ROW_ID : keyCols[0] ?? null;
  const keyedRows = useMemo(() => keyCols.length < 2 ? rows : rows.map((row) =>
    Object.defineProperty({ ...row }, ROW_ID, { value: JSON.stringify(keyCols.map((c) => row[c])) })), [rows, keyCols]);

  const {
    changeset, changesetRef, change, edit, newRowId, undo, redo, reset, canUndo, canRedo, hasChanges, changedRows,
  } = useChangeset(pkCol, keyCols);
  // New rows sit under the rows read so far, as in DBGate, named by their id alone.
  const insertedRows = useMemo<Record<string, unknown>[]>(
    () => (pkCol ? changeset.inserted.map((id) => (pkCol === ROW_ID ? Object.defineProperty({}, ROW_ID, { value: id }) : { [pkCol]: id })) : []),
    [changeset.inserted, pkCol],
  );
  const allRows = useMemo(() => (insertedRows.length ? [...keyedRows, ...insertedRows] : keyedRows), [keyedRows, insertedRows]);

  // Without a primary key there is no way to address a row in an UPDATE, and without a changeset
  // nowhere to save one, so edits could never be saved — don't let the user make them at all.
  const cellsReadOnly = !!readOnly || !pkCol || !batch;
  // Rows are added and deleted only through a changeset, which addresses them by key.
  const canChangeRows = batch && !editOnly && !cellsReadOnly;

  // Only cells that can change take an edit, however it arrives: typed, pasted, picked, set to NULL.
  const lockColumns = useMemo(() => new Map<string, LockColumn>(schema.map((c) => [c.name, { pk: c.pk, autoIncrement: isAutoIncrement(c) }])), [schema]);
  const canEditCell = useCallback((row: Record<string, unknown>, column: string) => {
    const col = lockColumns.get(column);
    return !cellsReadOnly && !!pkCol && !!col && !isCellLocked(col, String(row[pkCol]), changesetRef.current);
  }, [cellsReadOnly, pkCol, lockColumns, changesetRef]);
  const editCells = useCallback((changes: CellChange[]) => {
    const open = changes.filter((c) => canEditCell(c.row, c.column));
    if (open.length) edit(open);
  }, [canEditCell, edit]);

  // Widths dragged since the tab last kept them; the tab's are the rest.
  const [dragged, setDragged] = useState<Readonly<Record<string, number>>>({});
  const widths = useMemo(() => ({ ...columnWidths, ...dragged }), [columnWidths, dragged]);
  const { columns, columnOrder } = useGlideColumns(schema, columnNames, hiddenColumns, widths, allRows);
  const { getCellContent, onCellsEdited } = useGlideCellContent(allRows, columnOrder, schema, pkCol, editCells, changesetRef, colors, cellsReadOnly);
  const { gridSelection, onGridSelectionChange, selectedRowIndices, clearSelection } = useGlideSelection(allRows.length);
  const { handlePaste, getContextFk, openFkTable } = useGlideGridActions({
    displayRows: allRows, columnOrder, schema, pkCol, place, selectedSchema, dialect, edit: cellsReadOnly ? NOOP_EDIT : editCells,
    // A paste lands at the grid's cursor, which the form view does not show: there it would land unseen.
    gridSelection: formView ? undefined : gridSelection, containerRef,
  });

  // ── Save: every change in one changeset; the change set is emptied once the rows saved are read again ──
  const committedRef = useRef(false);
  const commit = useCallback(async () => {
    // Nothing to write: a new row nothing was put in is no INSERT.
    if (!onSaveChanges || changedRows === 0) return;
    try {
      await onSaveChanges(toGridChanges(changesetRef.current));
    } catch {
      // Nothing was saved and the caller has said why; the changes stay to be fixed.
      return;
    }
    committedRef.current = true;
  }, [onSaveChanges, changedRows, changesetRef]);
  // Not before: the rows read before the save would show for a moment without the values saved.
  useEffect(() => {
    if (committedRef.current) { committedRef.current = false; reset(); }
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  // The tab's unsaved dot and its close guard count what Save would write; the changes go with the grid.
  useEffect(() => { if (tabId) setUnsavedGridRows(tabId, changedRows, tabSlot); }, [tabId, tabSlot, changedRows]);
  useEffect(() => () => { if (tabId) setUnsavedGridRows(tabId, 0, tabSlot); }, [tabId, tabSlot]);

  // ── The rows starting over: back to the first row, with nothing selected ──
  const lastVisibleRef = useRef(-1);
  // The top row of the region Glide reported last.
  const lastTopRef = useRef(0);
  // The view the grid was last sent back to the top for, and the view rendered last: they differ
  // from the commit that brings a new view's rows until the effect below has run.
  const viewKeyRef = useRef(viewKey);
  const renderedViewKeyRef = useRef(viewKey);
  renderedViewKeyRef.current = viewKey;
  useEffect(() => {
    if (Object.is(viewKeyRef.current, viewKey)) return;
    viewKeyRef.current = viewKey;
    // Where the old rows were scrolled to says nothing about the new ones, and the scroll to the
    // top reports again — unless the grid is at the top already: as many rows are in view there,
    // and a scroll that moves nothing reports nothing.
    if (lastTopRef.current > 0) lastVisibleRef.current = -1;
    clearSelection();
    setFormRow(null);
    setWanted(null);
    gridRef.current?.scrollTo(0, 0, "vertical");
  }, [viewKey, clearSelection]);

  // ── Reading more rows once the last one read is in view ──
  const toldBlockedRef = useRef(false);
  const busy = loading || loadingMore || fetchingAll !== null;
  const checkLoadMore = useCallback(() => {
    if (!onLoadMore) return;
    const decision = loadMoreDecision({
      lastVisibleRow: lastVisibleRef.current, loadedRows: keyedRows.length, hasMore, busy, newRows: changeset.inserted.length,
    });
    if (decision === "load") onLoadMore();
    else if (decision === "blocked-by-new-rows" && !toldBlockedRef.current) {
      toldBlockedRef.current = true;
      toast.info("More rows load once the new rows are saved or reverted", { description: "They sit under the rows loaded so far." });
    }
  }, [onLoadMore, keyedRows.length, hasMore, busy, changeset.inserted.length]);
  const checkLoadMoreRef = useRef(checkLoadMore);
  checkLoadMoreRef.current = checkLoadMore;
  // Rows arriving, or a read ending, may leave the last row still in view.
  useEffect(() => { checkLoadMore(); }, [checkLoadMore]);
  useEffect(() => { if (changeset.inserted.length === 0) toldBlockedRef.current = false; }, [changeset.inserted.length]);

  const overlayRef = useRef<GridHeaderOverlayHandle>(null);
  // The cells in view, which a phone's long press looks for the cell under the finger among.
  const visibleRef = useRef<Rectangle>({ x: 0, y: 0, width: 0, height: 0 });
  const onVisibleRegionChanged = useCallback((range: Rectangle, tx: number) => {
    overlayRef.current?.sync({ x: range.x, tx });
    visibleRef.current = range;
    lastTopRef.current = range.y;
    // Glide reports on a new view's rows in the commit that brings them, from a layout effect,
    // before the grid has been sent back to the top: where the old rows were scrolled to, cut
    // short at the new rows' end — their last row, read as in view. The effect above decides.
    if (!Object.is(viewKeyRef.current, renderedViewKeyRef.current)) return;
    lastVisibleRef.current = range.y + range.height - 1;
    checkLoadMoreRef.current();
  }, []);

  // A slot of the header layer the browser scrolled into view — a ⌄ or a filter box at the grid's
  // edge: the grid scrolls its column into view instead, and the layer follows the scroll it reports.
  const revealColumn = useCallback((col: number) => {
    gridRef.current?.scrollTo(col, visibleRef.current.y, "horizontal");
  }, []);

  // ── New rows: added under the rest, with the cursor in the first column that takes a value ──
  const scrollToNewRow = useRef(false);
  const appendRow = useCallback(() => {
    if (!canChangeRows) return;
    scrollToNewRow.current = true;
    change((cs) => addRows(cs, [{ id: newRowId() }]));
  }, [canChangeRows, change, newRowId]);
  useEffect(() => {
    if (!scrollToNewRow.current) return;
    scrollToNewRow.current = false;
    const row = allRows.length - 1;
    const col = Math.max(0, columnOrder.findIndex((name) => {
      const col = schemaMap.get(name);
      return !col || !isAutoIncrement(col);
    }));
    // Focused first: Glide, focused with nothing selected, puts its cursor top-left from the
    // selection of its last render, which would land after ours.
    gridRef.current?.focus();
    onGridSelectionChange({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
    });
    gridRef.current?.scrollTo(col, row, "both");
  }, [allRows.length, columnOrder, schemaMap, onGridSelectionChange]);

  // ── The rows the selection covers, and what DBGate does to them ──
  const selectedRows = useMemo(() => selectedRowIndices.map((i) => allRows[i]).filter((row) => row != null), [selectedRowIndices, allRows]);
  // Marked to be deleted on Save; a new row simply goes, and the selection with it, which named it.
  const deleteSelectedRows = useCallback(() => {
    if (!pkCol || !canChangeRows || !selectedRows.length) return;
    change((cs) => deleteRows(cs, selectedRows, pkCol, keyCols));
    if (selectedRows.some((row) => isNewRowId(String(row[pkCol])))) clearSelection();
  }, [pkCol, canChangeRows, selectedRows, change, keyCols, clearSelection]);
  // Copies under the rest, bar what the database fills in.
  const cloneSelectedRows = useCallback(() => {
    if (!pkCol || !canChangeRows || !selectedRows.length) return;
    const cloned = schema.map((c) => ({ name: c.name, skip: isAutoIncrement(c) }));
    scrollToNewRow.current = true;
    change((cs) => addRows(cs, selectedRows.map((row) => ({ id: newRowId(), values: cloneValues(cs, row, pkCol, cloned) }))));
  }, [pkCol, canChangeRows, selectedRows, schema, change, newRowId]);
  const revertSelectedRows = useCallback(() => {
    if (!pkCol || cellsReadOnly || !selectedRows.length) return;
    change((cs) => revertRows(cs, new Set(selectedRows.map((row) => String(row[pkCol])))));
  }, [pkCol, cellsReadOnly, selectedRows, change]);
  // One step like any other, so Ctrl+Z brings the changes back.
  const revertAll = useCallback(() => change(() => EMPTY_CHANGESET), [change]);
  const setNullSelected = useCallback(() => {
    const changes: CellChange[] = [];
    forEachSelectedCell(gridSelection, columnOrder.length, allRows.length, (c, r) => {
      changes.push({ row: allRows[r]!, column: columnOrder[c]!, value: null });
    });
    editCells(changes);
  }, [gridSelection, columnOrder, allRows, editCells]);

  const scrollToColumn = useCallback((name: string) => {
    const col = columnOrder.indexOf(name);
    if (col < 0) return;
    const row = Math.max(0, Math.min(gridSelection.current?.cell[1] ?? 0, allRows.length - 1));
    gridRef.current?.scrollTo(col, row, "horizontal");
    // Focused first, as for a new row: Glide's own top-left cursor would land after ours.
    gridRef.current?.focus();
    if (allRows.length) {
      onGridSelectionChange({
        columns: CompactSelection.empty(), rows: CompactSelection.empty(),
        current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
      });
    }
  }, [columnOrder, gridSelection, allRows.length, onGridSelectionChange]);

  // ── The form view: the grid's current row, a field per column ──
  const formIndex = Math.max(0, Math.min(gridSelection.current?.cell[1] ?? 0, allRows.length - 1));
  // The column the form's cursor is on: the grid's cursor goes there, when the grid shows it.
  const [formField, setFormField] = useState<string | null>(null);
  const selectRow = useCallback((row: number) => {
    const shown = formField ? columnOrder.indexOf(formField) : -1;
    const col = shown >= 0 ? shown : Math.max(0, gridSelection.current?.cell[0] ?? 0);
    onGridSelectionChange({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
    });
  }, [formField, columnOrder, gridSelection, onGridSelectionChange]);
  // More rows can be read — not while a new row is unsaved, which they would land in front of.
  const canReadMore = hasMore && changeset.inserted.length === 0;
  const prefetch = useCallback((row: number) => {
    const decision = loadMoreDecision({ lastVisibleRow: row, loadedRows: keyedRows.length, hasMore, busy, newRows: changeset.inserted.length });
    if (decision === "load") onLoadMore?.();
  }, [keyedRows.length, hasMore, busy, changeset.inserted.length, onLoadMore]);
  // A row asked for before it was read — Next past the rows read, Last once every row is — gone to once it is.
  const [wanted, setWanted] = useState<number | "last" | null>(null);
  const formNavigate = useCallback((to: FormNavigation) => {
    if (!allRows.length) return;
    setWanted(null);
    if (to === "last" && canReadMore && onFetchAll) {
      void onFetchAll().then((done) => { if (done) setWanted("last"); });
      return;
    }
    if (to === "next" && formIndex >= allRows.length - 1 && canReadMore) {
      setWanted(formIndex + 1);
      prefetch(formIndex);
      return;
    }
    const next = navigateFormRow(formIndex, to, allRows.length);
    selectRow(next);
    // Landing on the last row read reads the next ones, as scrolling to it does in the grid.
    prefetch(next);
  }, [allRows.length, canReadMore, onFetchAll, formIndex, prefetch, selectRow]);
  useEffect(() => {
    if (wanted === null) return;
    if (wanted === "last") {
      if (!hasMore) { setWanted(null); selectRow(allRows.length - 1); }
    } else if (wanted < allRows.length) {
      setWanted(null);
      selectRow(wanted);
    }
  }, [wanted, hasMore, allRows.length, selectRow]);
  // A phone's Switch to form: the current row in its sheet.
  const openRowForm = useCallback(() => {
    if (allRows.length) setFormRow(formIndex);
    else toast.info("No rows to show as a form");
  }, [allRows.length, formIndex]);
  // The row the form shows, which Revert row changes takes back alone: a selection of several rows
  // made in the grid is not what the form has in front of it.
  const formRecord = formView ? allRows[formIndex] : undefined;
  const formRowId = formRecord && pkCol ? String(formRecord[pkCol]) : null;
  // The reference shown under the grid follows the rows selected here, as they were read: a new row
  // has no key yet and an edit is not saved, so neither names the rows that belong to it.
  const readRows = useMemo(() => {
    const at = formView ? [formIndex] : selectedRowIndices;
    return at.flatMap((i) => (i < rows.length ? [rows[i]!] : []));
  }, [formView, formIndex, selectedRowIndices, rows]);
  useEffect(() => { onSelectedRowsChange?.(readRows); }, [onSelectedRowsChange, readRows]);
  // Rows read again in place — after Save, or Refresh in the form — can come back in another order:
  // Postgres hands back a row it has just updated last. The form keeps to its row, by key, while that
  // row is still read, where DBGate keeps to the place and shows another row; a new view (another
  // sort or filter) starts at the top, as the grid does.
  const formHeldRef = useRef<{ id: string; view: unknown } | null>(null);
  useEffect(() => {
    const held = formHeldRef.current;
    if (!held || !pkCol || held.id === formRowId || !Object.is(held.view, viewKey)) return;
    const at = allRows.findIndex((r) => String(r[pkCol]) === held.id);
    if (at >= 0) selectRow(at);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps -- only rows read again move the form
  useEffect(() => {
    formHeldRef.current = formRowId !== null ? { id: formRowId, view: viewKey } : null;
  }, [formRowId, viewKey]);
  const revertFormRow = useCallback(() => {
    if (formRowId === null || cellsReadOnly) return;
    change((cs) => revertRows(cs, new Set([formRowId])));
  }, [formRowId, cellsReadOnly, change]);
  // The form's editor saves with Ctrl+S once its value is in the change set, which takes a render.
  const [saveAsked, setSaveAsked] = useState(false);
  useEffect(() => {
    if (!saveAsked) return;
    setSaveAsked(false);
    void commit();
  }, [saveAsked, commit]);
  const askSave = useCallback(() => setSaveAsked(true), []);
  // Back from the form, the grid takes the keys again, its cursor on the row and the field the form showed.
  const shownViewRef = useRef(formView);
  useEffect(() => {
    if (shownViewRef.current === formView) return;
    shownViewRef.current = formView;
    if (formView) return;
    const at = gridSelection.current?.cell;
    const shown = formField ? columnOrder.indexOf(formField) : -1;
    const col = at ? (shown >= 0 ? shown : at[0]) : 0;
    if (at) selectRow(at[1]);
    const root = containerRef.current;
    if (!root) return;
    // Glide puts its canvas in two or three frames after the editor (measured: the third frame).
    return focusOnceDrawn(root, () => {
      gridRef.current?.focus();
      if (!root.contains(document.activeElement)) return false;
      if (at) gridRef.current?.scrollTo(col, at[1], "both");
      return true;
    });
  }, [formView]); // eslint-disable-line react-hooks/exhaustive-deps
  // Switched to by hand — not the tab reopening on it, which must not take the keys from wherever they are.
  const formJustSwitched = formView && !shownViewRef.current;
  // DBGate's focusOnVisible: the tab in front — just opened, or picked — hands its keys to the grid or the
  // form, once the rows have come. Never from where the user works: a field being typed in, a dialog,
  // or this tab already.
  useEffect(() => {
    const root = containerRef.current;
    if (!focusOnVisible || !root) return;
    const active = document.activeElement;
    const tab = root.closest("[data-tab-pool-id]") ?? root;
    if (active && active !== document.body
      && (tab.contains(active) || isTextField(active) || active.closest('[role="dialog"], [role="alertdialog"]'))) return;
    return focusOnceDrawn(root, () => {
      if (formView) root.querySelector<HTMLElement>("[data-form-view]")?.focus({ preventScroll: true });
      else gridRef.current?.focus();
      return root.contains(document.activeElement);
    });
  }, [focusOnVisible]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    return keepKeysOnRemoval(root, () => {
      if (formView) root.querySelector<HTMLElement>("[data-form-view]")?.focus({ preventScroll: true });
      else gridRef.current?.focus();
    });
  }, [formView]);

  // ── DBGate's Cell data view: what the selection holds, beside the grid — a phone's is a sheet ──
  // What a cell shows now: an edit's value, and on a new row only what was put in it.
  const valueNow = useCallback((row: Record<string, unknown>, column: string) => {
    if (!pkCol) return row[column];
    const pending = changeset.cells.get(cellId(row[pkCol], column));
    if (pending) return pending.newVal;
    return isNewRowId(String(row[pkCol])) ? undefined : row[column];
  }, [pkCol, changeset]);
  const [cellData, setCellData] = useState(false);
  const [cellDataSheet, setCellDataSheet] = useState(false);
  // The format View cell as JSON document opens the view at, taken once.
  const [cellDataAsk, setCellDataAsk] = useState<CellDataChoice | null>(null);
  const clearCellDataAsk = useCallback(() => setCellDataAsk(null), []);
  const [cellDataWidth, setCellDataWidth] = useState(readCellDataWidth);
  const changeCellDataWidth = useCallback((width: number) => {
    setCellDataWidth(width);
    keepCellDataWidth(width);
  }, []);
  // Not beside the form view, which shows every value of its row itself.
  const cellDataShown = cellData && !formView && !mobile;
  // A row selected whole opens it, as in DBGate: put away, it opens again for the next selection.
  useEffect(() => {
    if (gridSelection.rows.length > 0 && !formView && !mobile) setCellData(true);
  }, [gridSelection]); // eslint-disable-line react-hooks/exhaustive-deps -- a selection made, not the view switched
  const showCellData = useCallback(() => (mobile ? setCellDataSheet(true) : setCellData(true)), [mobile]);
  const toggleCellData = useCallback(() => (mobile ? setCellDataSheet(true) : setCellData((open) => !open)), [mobile]);
  const closeCellData = useCallback((hadFocus: boolean) => {
    setCellData(false);
    // Its focus would go nowhere: back to the grid it was beside.
    if (hadFocus) gridRef.current?.focus();
  }, []);
  // Read only while it is shown: a selection of every cell is a great many values to read on each change.
  const cellDataSelection = useMemo(
    () => (cellDataShown || cellDataSheet
      ? collectCellData(gridSelection, columnOrder, allRows.length, (r, column) => valueNow(allRows[r]!, column))
      : NO_CELL_DATA),
    [cellDataShown, cellDataSheet, gridSelection, columnOrder, allRows, valueNow],
  );
  const cellDataSource = useMemo<CellDataSource>(() => ({
    selection: cellDataSelection,
    columns: columnOrder.flatMap((name) => schemaMap.get(name) ?? []),
    record: (row) => allRows[row]!,
    rowId: (row) => (pkCol ? String(allRows[row]?.[pkCol]) : String(row)),
    rowValues: (row) => {
      const record = allRows[row]!;
      // A new row's columns nothing was put in are left out: DBGate's new row has none of them.
      return Object.fromEntries(schema.flatMap((c) => {
        const value = valueNow(record, c.name);
        return value === undefined ? [] : [[c.name, value] as const];
      }));
    },
    canEdit: canEditCell,
    onEdit: editCells,
    onSave: askSave,
  }), [cellDataSelection, columnOrder, schemaMap, allRows, pkCol, schema, valueNow, canEditCell, editCells, askSave]);

  // ── DBGate's Copy: the block the selection covers, in the format Set format chose ──
  const copySource = useMemo<GridCopySource>(() => {
    const rowNow = (r: number) => Object.fromEntries(schema.map((c) => [c.name, valueNow(allRows[r]!, c.name)]));
    return {
      selection: gridSelection, columns: columnOrder, rowCount: allRows.length, rowNow,
      // A new row is not in the database yet: what it would be found by is what it holds.
      rowStored: (r) => (pkCol && isNewRowId(String(allRows[r]![pkCol])) ? rowNow(r) : allRows[r]!),
      target: {
        // DBGate's, for rows that name no table.
        table: selectedTable ?? "target", schema: selectedSchema, dialect: dialect ?? "postgres",
        // DBGate's: the primary key, else the first column.
        keyColumns: keyCols.length ? keyCols : schema.slice(0, 1).map((c) => c.name),
        kinds: new Map(schema.map((c) => [c.name, classifyColumnType(dialect ?? "postgres", c.type)])),
      },
    };
  }, [schema, valueNow, allRows, gridSelection, columnOrder, pkCol, selectedTable, selectedSchema, dialect, keyCols]);
  const focusGrid = useCallback(() => gridRef.current?.focus(), []);
  const clearSelectedCells = useCallback(() => { void gridRef.current?.emit("delete"); }, []);
  const gridCopy = useGridCopy(copySource, !cellsReadOnly, clearSelectedCells, focusGrid);

  useImperativeHandle(ref, () => ({
    save: () => { void commit(); },
    revert: revertAll,
    newRow: appendRow,
    deleteSelectedRows,
    undo,
    redo,
    scrollToColumn,
    focus: () => gridRef.current?.focus(),
    formNavigate,
    openRowForm,
    toggleCellData,
  }), [commit, revertAll, appendRow, deleteSelectedRows, undo, redo, scrollToColumn, formNavigate, openRowForm, toggleCellData]);

  // What a toolbar outside the grid shows: Save counts the rows it would write, as DBGate's does.
  const selectedColumns = useMemo(() => {
    const names: string[] = [];
    for (const i of gridSelection.columns) if (columnOrder[i]) names.push(columnOrder[i]);
    return names;
  }, [gridSelection.columns, columnOrder]);
  const formAtFirst = formIndex <= 0;
  const formAtLast = formIndex >= allRows.length - 1 && !canReadMore;
  useEffect(() => {
    onEditStateChange?.({
      pending: changedRows, newRows: changeset.inserted.length, selectedRows: selectedRowIndices.length, selectedColumns,
      canChangeRows, canUndo, canRedo, cellData: cellDataShown,
      ...(formView ? { form: { atFirst: formAtFirst, atLast: formAtLast } } : {}),
    });
  }, [
    onEditStateChange, changedRows, changeset.inserted.length, selectedRowIndices.length, selectedColumns, canChangeRows, canUndo, canRedo,
    cellDataShown, formView, formAtFirst, formAtLast,
  ]);

  // ── Column widths: dragged on the header, kept by the tab once the drag ends ──
  const keptWidthsRef = useRef(columnWidths);
  keptWidthsRef.current = columnWidths;
  const draggedRef = useRef(dragged);
  draggedRef.current = dragged;
  const onColumnResize = useCallback((col: GridColumn, size: number) => {
    const id = col.id ?? col.title;
    setDragged((d) => (d[id] === size ? d : { ...d, [id]: size }));
  }, []);
  const onColumnResizeEnd = useCallback((col: GridColumn, size: number) => {
    if (!onColumnWidthsChange) return;
    onColumnWidthsChange({ ...keptWidthsRef.current, ...draggedRef.current, [col.id ?? col.title]: size });
    setDragged({});
  }, [onColumnWidthsChange]);

  const openCellMenu = useCallback(([colIdx, rowIdx]: Item, position: CellPoint) => {
    // As in DBGate, the menu acts on the selection, which a right-click outside it moves there.
    if (!selectionHasCell(gridSelection, colIdx, rowIdx)) {
      onGridSelectionChange({
        columns: CompactSelection.empty(), rows: CompactSelection.empty(),
        current: { cell: [colIdx, rowIdx], range: { x: colIdx, y: rowIdx, width: 1, height: 1 }, rangeStack: [] },
      });
    }
    setContextMenu({ position, rowIdx, colIdx });
  }, [gridSelection, onGridSelectionChange]);
  // A phone's menu comes from a press held on a cell, found among the cells in view by their bounds.
  const cellAt = useCallback(({ x, y }: CellPoint, target: EventTarget | null): Item | null => {
    const grid = gridRef.current;
    const root = containerRef.current;
    if (!grid || !root || !isGridSurface(root, target)) return null;
    // A row scrolled half under the header reaches up behind it: a press there is on the header.
    const header = grid.getBounds(0, -1);
    if (!header || y < header.y + header.height) return null;
    const region = visibleRef.current;
    const top = Math.max(0, region.y);
    const within = (at: number, from: number, size: number) => at >= from && at < from + size;
    let col = -1;
    for (let c = Math.max(0, region.x); c <= region.x + region.width && col < 0; c++) {
      const b = grid.getBounds(c, top);
      if (b && within(x, b.x, b.width)) col = c;
    }
    if (col < 0) return null;
    for (let r = top; r <= region.y + region.height; r++) {
      const b = grid.getBounds(col, r);
      if (b && within(y, b.y, b.height)) return [col, r];
    }
    return null;
  }, []);
  const { handlers: pressHandlers, pressNow, travelled: touchTravelled } = useCellLongPress(mobile && !formView, cellAt, openCellMenu);
  const handleCellContextMenu = useCallback(([colIdx, rowIdx]: Item, event: {
    preventDefault: () => void; localEventX: number; localEventY: number; bounds: { x: number; y: number }; isTouch: boolean;
  }) => {
    event.preventDefault();
    // A finger's menu is the held press's: the browser's own long press only opens it sooner, and
    // Glide's — told when the finger lifts, after a press that moved — never does.
    if (mobile && event.isTouch) {
      pressNow();
      return;
    }
    openCellMenu([colIdx, rowIdx], { x: event.bounds.x + event.localEventX, y: event.bounds.y + event.localEventY });
  }, [mobile, pressNow, openCellMenu]);
  // What a key on the selection runs, set once the commands below are: null where the grid has none.
  const selectionKeyRef = useRef<(command: GridKeyCommand) => (() => void) | null>(() => null);
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Not from a dialog the grid opened: its keys reach here through React, and its Ctrl+Enter is its own OK.
    const place = tableKeyPlace(e.currentTarget, e.target);
    if (place && (e.metaKey || e.ctrlKey) && e.key === "Enter" && changedRows > 0) { e.preventDefault(); void commit(); return; }
    // Undo, redo and Revert row changes are the grid's, wherever it is shown; a filter box and the
    // cell editor keep their own.
    const command = place && tableKeyCommand(e.nativeEvent, place);
    // A Query tab's result has no table view around it to take Ctrl+S: the grid saves its own edited
    // rows, and with none the key goes on to the tab, which saves its SQL.
    if (command === "save" && editOnly && changedRows > 0) { e.preventDefault(); e.stopPropagation(); void commit(); return; }
    if (command && command !== "swallow" && isGridKeyCommand(command)) {
      const run = selectionKeyRef.current(command);
      // Not a command this grid has: the key stays the browser's.
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      run();
      return;
    }
    if (command !== "undo" && command !== "redo" && command !== "revert-rows") return;
    e.preventDefault();
    e.stopPropagation();
    if (command === "undo") undo();
    else if (command === "redo") redo();
    else if (formView) revertFormRow();
    else revertSelectedRows();
  }, [changedRows, commit, editOnly, undo, redo, formView, revertFormRow, revertSelectedRows]);

  // ── Drawing the change set: row washes from the row's theme, and the marks over a cell ──
  const allRowsRef = useRef(allRows);
  allRowsRef.current = allRows;
  const columnOrderRef = useRef(columnOrder);
  columnOrderRef.current = columnOrder;
  const getRowThemeOverride = useCallback((row: number): Partial<Theme> | undefined => {
    const target = allRowsRef.current[row];
    if (!target || !pkCol) return undefined;
    return rowChangeTheme(rowChange(changesetRef.current, String(target[pkCol])), colors);
  }, [pkCol, colors, changesetRef]);
  // ── DBGate's form button in a foreign key cell, on a desktop: the row the key refers to, in a new tab ──
  const fkButtonsRef = useRef(false);
  fkButtonsRef.current = !mobile && !formView && (!!onOpenReference || !!place);
  const schemaMapRef = useRef(schemaMap);
  schemaMapRef.current = schemaMap;
  /** The key a cell's button follows, with the value the cell shows now; null for a cell with no button. */
  const fkButtonOf = useCallback((col: number, row: number) => {
    if (!fkButtonsRef.current) return null;
    const column = columnOrderRef.current[col];
    const record = allRowsRef.current[row];
    const fk = column ? schemaMapRef.current.get(column)?.fk : undefined;
    if (!column || !record || !fk) return null;
    const pending = pkCol ? changesetRef.current.cells.get(cellId(record[pkCol], column)) : undefined;
    const value = pending ? pending.newVal : pkCol && isNewRowId(String(record[pkCol])) ? undefined : record[column];
    return value === null || value === undefined || isBinaryValue(value) ? null : { column, record, fk, value };
  }, [pkCol, changesetRef]);
  // The foreign key cell under the pointer, and whether the pointer is on its button.
  const fkHoverRef = useRef<{ col: number; row: number; on: boolean } | null>(null);
  const onMouseMove = useCallback((args: GridMouseEventArgs) => {
    const before = fkHoverRef.current;
    const [col, row] = args.location;
    const now = args.kind === "cell" && fkButtonOf(col, row) ? { col, row, on: isOnFkButton(args.localEventX, args.localEventY, args.bounds) } : null;
    if (before?.col === now?.col && before?.row === now?.row && before?.on === now?.on) return;
    fkHoverRef.current = now;
    gridRef.current?.updateCells([before, now].flatMap((h) => (h ? [{ cell: [h.col, h.row] as Item }] : [])));
  }, [fkButtonOf]);

  const drawCell = useCallback<DrawCellCallback>((args, drawContent) => {
    const button = fkButtonOf(args.col, args.row);
    if (button) {
      drawBesideFkButton(args.ctx, args.rect, { right: args.cell.contentAlign === "right", padding: args.theme.cellHorizontalPadding }, drawContent);
      const hover = fkHoverRef.current;
      const hovered = hover?.col === args.col && hover.row === args.row;
      const cursor = gridSelectionRef.current.current?.cell;
      const current = cursor?.[0] === args.col && cursor[1] === args.row;
      drawFkButton(args.ctx, args.rect, hovered && hover.on ? "hover" : hovered || current ? "shown" : "faint", args.theme);
      // Glide hands the hovered cell a way to set the pointer, and takes it back when a draw leaves it unset.
      if (hovered && hover.on) (args as { overrideCursor?: (cursor: string) => void }).overrideCursor?.("pointer");
    } else {
      drawContent();
    }
    const target = allRowsRef.current[args.row];
    const column = columnOrderRef.current[args.col];
    if (!target || !column || !pkCol) return;
    drawCellMark(args.ctx, args.rect, cellMark(changesetRef.current, String(target[pkCol]), column), colors);
  }, [pkCol, colors, changesetRef, fkButtonOf]);

  // ── ⋯ in a foreign key cell's editor: the referenced table's rows, one picked into the cell ──
  const [cellLookup, setCellLookup] = useState<{ row: Record<string, unknown>; column: string; lookup: NonNullable<ReturnType<NonNullable<typeof lookupFor>>> } | null>(null);
  const gridSelectionRef = useRef(gridSelection);
  gridSelectionRef.current = gridSelection;
  const fkTables = useMemo(() => new Map(schema.flatMap((c) => (c.fk ? [[c.name, c.fk.table] as const] : []))), [schema]);
  const editorDeps = useRef({ lookupFor, fkTables });
  editorDeps.current = { lookupFor, fkTables };
  // One function for the grid's life: the editor Glide has open is built from it.
  const provideEditor = useCallback((cell: GridCell) => {
    // A cell that cannot change keeps Glide's viewer: nothing typed there is saved.
    if ("readonly" in cell && cell.readonly) return undefined;
    const { lookupFor: lookupOf, fkTables: tables } = editorDeps.current;
    // Glide edits the cell the cursor is on.
    const at = gridSelectionRef.current.current?.cell;
    if (!lookupOf || !at) return cellEditor(cell);
    const column = columnOrderRef.current[at[0]];
    const row = allRowsRef.current[at[1]];
    const table = column ? tables.get(column) : undefined;
    if (!column || !row || !table) return cellEditor(cell);
    // No ⋯ that would open nothing: the table it names has to be one the lookup can read.
    const lookup = lookupOf(column);
    if (!lookup) return cellEditor(cell);
    return fkCellEditor(cell, table, () => setCellLookup({ row, column, lookup }));
  }, []);

  // DBGate's header: Glide draws the column titles in the top band, and the column menu buttons
  // and — on a desktop — the filter row are HTML laid over the canvas (grid/grid-header-overlay.tsx).
  // A phone filters through chips and a sheet, which a column's title or ⌄ opens.
  const filterRow = !!filtering && !mobile;
  const columnSheet = mobile ? filtering?.onColumnSheet : undefined;
  const titleBand = mobile ? TITLE_BAND_TOUCH : TITLE_BAND;
  const headerHeight = titleBand + (filterRow ? FILTER_BAND : 0);
  const markerWidth = rowMarkerWidth(allRows.length);

  // A foreign key's button: the referenced row as a form in a new tab, or — where the grid has no
  // table to open it from — a Query tab reading it.
  const followKey = useCallback(({ column, record, fk, value }: NonNullable<ReturnType<typeof fkButtonOf>>) => {
    if (onOpenReference) onOpenReference(column, { ...record, [column]: value });
    else openFkTable(fk, value);
  }, [onOpenReference, openFkTable]);
  // A phone changes a row through its form: a tap on a cell opens the row, and nothing else — not
  // the checkbox a boolean cell draws, which a tap would otherwise toggle unseen behind the form.
  // A finger that scrolled the grid by less than a row is no tap, though Glide reports one. A long
  // press is the cell's menu, and the row number selects rows, as everywhere else. On a desktop a
  // click does something of its own only on a foreign key's button.
  const onCellClicked = useCallback(([col, row]: Item, event: CellClickedEventArgs) => {
    if (col < 0) return;
    if (mobile) {
      event.preventDefault();
      if (!event.isLongTouch && !touchTravelled()) setFormRow(row);
      return;
    }
    if (event.isLongTouch) return;
    const button = fkButtonOf(col, row);
    if (!button || !isOnFkButton(event.localEventX, event.localEventY, event.bounds)) return;
    // Not the editor a second click on the cursor's cell opens.
    event.preventDefault();
    followKey(button);
  }, [mobile, touchTravelled, fkButtonOf, followKey]);
  // Previous and Next take the grid along: the row seen last is the one in view once the sheet goes.
  const showFormRow = useCallback((row: number) => {
    setFormRow(row);
    const col = Math.max(0, gridSelectionRef.current.current?.cell[0] ?? 0);
    onGridSelectionChange({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
    });
    gridRef.current?.scrollTo(col, row, "vertical");
  }, [onGridSelectionChange]);
  const titleColumns = useMemo<TitleColumn[]>(() => columnOrder.map((name) => {
    const col = schemaMap.get(name);
    return {
      name,
      type: col?.type ?? "",
      notNull: !!col && !col.nullable,
      icon: col ? titleIcon({ pk: col.pk, fk: col.fk, autoIncrement: isAutoIncrement(col) }) : null,
    };
  }), [columnOrder, schemaMap]);
  // A new drawer whenever what it draws changes, for Glide to draw with; `drawnCellContent` below
  // is what makes it draw.
  const drawHeader = useMemo(() => columnTitleDrawer({
    titleHeight: titleBand,
    columnAt: (i) => titleColumns[i],
    sortOf: (name) => {
      const at = sortPosition(sort, name);
      return at && { dir: at.dir, index: sort.length > 1 ? at.index : null };
    },
    mono: readCssVar("--font-mono") || "monospace",
    cornerCheckbox: !sidePanel,
  }), [titleColumns, sort, sidePanel, titleBand, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  // Glide draws the canvas again only when a prop its blit check compares has changed
  // (`computeCanBlit`), and neither the rows `getCellContent` reads through refs nor the header
  // drawer is one: a new view with as many rows as the last, a new sort or a reverted edit left the
  // old picture on screen. A new `getCellContent` is one, and redraws the titles with the cells.
  const drawnCellContent = useMemo(() => (cell: Item) => getCellContent(cell), [getCellContent, allRows, changeset, drawHeader, colors]); // eslint-disable-line react-hooks/exhaustive-deps
  const overlayColumns = useMemo(() => columns.map((c) => ({ id: c.id ?? c.title, width: (c as { width: number }).width })), [columns]);
  const scrollbar = useScrollbarSize(containerRef, allRows.length, columns.length, !formView);

  const filterKinds = useMemo(() => new Map(filtering?.columns.map((c) => [c.name, c.kind])), [filtering?.columns]);
  const menuColumn = headerMenu?.colName ?? null;
  // Kept apart from the rest of the grid's state, so selecting a cell does not redraw every slot.
  const renderHeaderSlot = useCallback((c: OverlayColumn) => {
    const kind = filterKinds.get(c.id) ?? "other";
    return (
      <>
        <button
          type="button" aria-haspopup="menu" aria-expanded={menuColumn === c.id} aria-label={`Column menu: ${c.id}`} title="Column menu"
          className={cn(
            "pointer-events-auto absolute right-0.5 grid rounded text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text aria-expanded:bg-surface-hover aria-expanded:text-text",
            // A finger's 44 px, with the ⌄ where a desktop has it, clear of the title.
            mobile ? "size-11 items-center justify-items-end pr-1" : "size-5 place-items-center",
          )}
          style={{ top: (titleBand - (mobile ? 44 : 20)) / 2 }}
          onClick={(e) => {
            if (columnSheet) return columnSheet(c.id);
            const r = e.currentTarget.getBoundingClientRect();
            setHeaderMenu({ colName: c.id, bounds: { x: r.left, y: r.top, width: r.width, height: r.height } });
          }}
        >
          <ChevronDown className="size-3" />
        </button>
        {filterRow && filtering && (
          <div className="pointer-events-none absolute inset-x-1" style={{ top: titleBand + 4 }}>
            <FilterCell {...columnFilterCellProps(filtering, c.id, kind, fkTables.get(c.id))} onArrowDown={() => gridRef.current?.focus()} />
          </div>
        )}
      </>
    );
  }, [filterRow, filtering, filterKinds, fkTables, menuColumn, columnSheet, mobile, titleBand]);
  const onHeaderClicked = useCallback((col: number) => {
    const c = columns[col];
    if (c && columnSheet) columnSheet(c.id ?? c.title);
  }, [columns, columnSheet]);

  const copyColumnName = useCallback((name: string) => {
    void copyToClipboard(name).then((ok) => {
      if (ok) toast.success("Column name copied");
      else toast.error("Could not copy the column name");
    });
  }, []);

  const stats = useMemo(
    () => selectionStats(gridSelection, columnOrder.length, allRows.length, (c, r) => {
      const row = allRows[r];
      const name = columnOrder[c];
      // A cell counts with the value it now shows.
      return row && name ? valueNow(row, name) : undefined;
    }),
    [gridSelection, columnOrder, allRows, valueNow],
  );

  // ── DBGate's commands on the selection (grid/selection-commands.ts) ──
  // Filter selected value: each column's filter set to the values selected in it, the others kept.
  const filterSelectedValues = useCallback(() => {
    if (!filtering) return;
    const result = selectedValueFilters(
      (visit) => forEachSelectedCell(gridSelection, columnOrder.length, allRows.length, (c, r) => {
        const column = columnOrder[c]!;
        visit({ column, value: valueNow(allRows[r]!, column) });
      }),
      (column) => filterKinds.get(column),
    );
    if (!result.ok) {
      toast.error(`Too many values selected in ${result.column} to filter by`, { description: "Select fewer cells in that column." });
      return;
    }
    if (result.filters.size === 0) return;
    filtering.onChange((f) => [...result.filters].reduce((next, [column, text]) => withColumnFilter(next, column, text), f));
  }, [filtering, gridSelection, columnOrder, allRows, valueNow, filterKinds]);
  // Hide column: the cursor stays where the hidden columns began, on the column that moves into their place.
  const hideSelectedColumns = useCallback(() => {
    const at = selectedColumnIndices(gridSelection, columnOrder.length);
    if (!onHideColumns || !at.length) return;
    onHideColumns(at.map((i) => columnOrder[i]!));
    const left = columnOrder.length - at.length;
    const row = gridSelection.current?.cell[1];
    if (left === 0 || row === undefined) {
      clearSelection();
      return;
    }
    const col = Math.min(at[0]!, left - 1);
    onGridSelectionChange({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
    });
  }, [gridSelection, columnOrder, onHideColumns, clearSelection, onGridSelectionChange]);
  const saveCellToFile = useCallback((value: unknown, column: string, row: Record<string, unknown>) => {
    const base = cellFileBase(selectedTable, column);
    // Bytes past the row's preview: read whole on the server, the row found again by its key as read.
    if (isBinaryValue(value) && value.truncated && startCellDownload && keyCols.length) {
      const name = cellFileName(value, base);
      const id = toast.loading(`Reading ${name}…`);
      startCellDownload(column, rowKeyOf(row, keyCols), name).then((ticket) => {
        if (!ticket) {
          toast.dismiss(id);
          return;
        }
        triggerDownload(gridExportDownloadUrl(ticket.ticket), ticket.fileName);
        toast.success(`Downloading ${ticket.fileName}`, { id });
      }, (e: unknown) => {
        toast.error("Could not save the cell to a file", { id, description: (e as Error).message });
      });
      return;
    }
    const file = cellFile(value, base);
    if (file.ok) downloadCellFile(file);
    else toast.error("Could not save the cell to a file", { description: file.reason });
  }, [selectedTable, startCellDownload, keyCols]);

  // ── DBGate's editors in a dialog: a cell's value, a row as JSON, new rows from JSON ──
  const [textDialog, setTextDialog] = useState<TextDialog | null>(null);
  const documentColumns = useMemo<DocumentColumn[]>(() => schema.map((c) => ({ name: c.name, kind: fieldKind(c) })), [schema]);
  const rowValuesNow = useCallback((row: Record<string, unknown>) => (
    Object.fromEntries(schema.map((c) => [c.name, valueNow(row, c.name)]))
  ), [schema, valueNow]);
  /** What OK does with the dialog's text: null once it is in the change set, or why it cannot be. */
  const takeText = useCallback((dialog: TextDialog, text: string): string | null => {
    if (dialog.kind === "cell") {
      if (text === dialog.initial) return null;
      const col = schemaMap.get(dialog.column);
      const parsed = parseFormText(text, col ? fieldKind(col) : "text");
      if (!parsed.ok) return `${dialog.column}: ${parsed.error}`;
      editCells([{ row: dialog.row, column: dialog.column, value: parsed.value }]);
      return null;
    }
    const read = readJsonDocuments(text, dialog.kind === "add");
    if (!read.ok) return read.error;
    if (dialog.kind === "row") {
      const result = documentChanges(read.documents[0]!, rowValuesNow(dialog.row), documentColumns, (column) => canEditCell(dialog.row, column));
      if (!result.ok) return result.error;
      editCells(result.changes.map(({ column, value }) => ({ row: dialog.row, column, value })));
      return null;
    }
    // A new row's key the database fills in is locked, as it is in the grid.
    const result = newRowValues(read.documents, documentColumns, (column) => {
      const lock = lockColumns.get(column);
      return !!lock && lock.pk && lock.autoIncrement;
    });
    if (!result.ok) return result.error;
    scrollToNewRow.current = true;
    change((cs) => addRows(cs, result.rows.map((values) => ({ id: newRowId(), values }))));
    return null;
  }, [schemaMap, editCells, rowValuesNow, documentColumns, canEditCell, lockColumns, change, newRowId]);

  // ── DBGate's Generate SQL from data (grid/generate-sql.ts): the rows and columns the selection lies on ──
  const [sqlDialog, setSqlDialog] = useState<{
    rows: Iterable<SqlSourceRow>; columns: string[]; allColumns: string[]; target: CopySqlTarget;
  } | null>(null);
  const openGenerateSql = useCallback(() => {
    const block = selectedBlock(gridSelection, columnOrder.length, allRows.length);
    if (!block.rows.length) return;
    const { rowNow, rowStored, target } = copySource;
    // Read again whenever the dialog's choices change, and only as far as the SQL is written.
    const rows: Iterable<SqlSourceRow> = {
      *[Symbol.iterator]() {
        for (const r of block.rows) {
          yield { now: rowNow(r), stored: rowStored(r), isNew: !!pkCol && isNewRowId(String(allRows[r]![pkCol])) };
        }
      },
    };
    setSqlDialog({ rows, columns: block.columns.map((c) => columnOrder[c]!), allColumns: schema.map((c) => c.name), target });
  }, [gridSelection, columnOrder, allRows, copySource, pkCol, schema]);

  // ── DBGate's keys on the selection (grid/table-keys.ts): the cell menu's commands, where the menu has them ──
  selectionKeyRef.current = (command) => {
    // The form's keys are its own (grid/form-view.tsx).
    if (formView) return null;
    // As the cell menu (below) offers each: where it would leave the item out or grey it, the key is the browser's.
    switch (command) {
      case "clone-rows": return canChangeRows && selectedRows.length > 0 ? cloneSelectedRows : null;
      case "set-null": return weighSelection().editable ? setNullSelected : null;
      case "find-column": return onFindColumn ?? null;
      case "hide-columns": return onHideColumns && selectedColumnIndices(gridSelection, columnOrder.length).length > 0 ? hideSelectedColumns : null;
      case "filter-selected": return filtering && weighSelection().filterable ? filterSelectedValues : null;
      case "edit-row-json": {
        const row = !cellsReadOnly && selectedRows.length === 1 ? selectedRows[0]! : null;
        return row && (() => setTextDialog({ kind: "row", row, initial: rowDocumentText(rowValuesNow(row), documentColumns) }));
      }
      // A right-click selects the cell it lands on, so the menu never has nothing to generate from; a key can.
      case "generate-sql": return onOpenGeneratedSql && selectedTable && selectedRows.length > 0 ? openGenerateSql : null;
    }
  };

  // ── DBGate's cell menu (grid/cell-menu.ts): at the pointer on a desktop, in a sheet on a phone ──
  const contextRow = contextMenu ? allRows[contextMenu.rowIdx] : null;
  const contextColName = contextMenu ? columnOrder[contextMenu.colIdx] : null;
  const contextFk = getContextFk(contextColName ?? null);
  const contextCellValue = contextRow && contextColName ? contextRow[contextColName] : null;
  // The row as it reads now, edits included, for the row its foreign key refers to.
  const contextShownRow = useMemo(() => {
    if (!contextRow || !pkCol) return contextRow;
    const isNew = isNewRowId(String(contextRow[pkCol]));
    return Object.fromEntries(schema.map((c) => {
      const pending = changeset.cells.get(cellId(contextRow[pkCol], c.name));
      return [c.name, pending ? pending.newVal : isNew ? undefined : contextRow[c.name]];
    }));
  }, [contextRow, pkCol, schema, changeset]);
  // Read when asked — once the menu opens, or a key on the selection is pressed: a selection of
  // every cell is a great many cells to weigh.
  const weighSelection = useCallback((): CellMenuSelection => {
    // A hidden column's edit counts too: whatever Revert row changes would take back.
    const changed = !!pkCol && revertRows(changeset, new Set(selectedRows.map((row) => String(row[pkCol])))) !== changeset;
    return summarizeSelection((visit) => forEachSelectedCell(gridSelection, columnOrder.length, allRows.length, (c, r) => {
      const row = allRows[r]!;
      const column = columnOrder[c]!;
      const value = valueNow(row, column);
      const kind = filterKinds.get(column);
      visit({
        value,
        editable: canEditCell(row, column),
        // What no filter can spell: bytes, JSON, and the value a new row has not been given.
        filterable: !!kind && canChooseValues(kind) && value !== undefined && !isBinaryValue(value),
      });
    }), selectedRows.length, changed);
  }, [pkCol, changeset, selectedRows, gridSelection, columnOrder, allRows, valueNow, filterKinds, canEditCell]);
  const menuSelection = useMemo(() => (contextMenu ? weighSelection() : null), [contextMenu, weighSelection]);
  const cellEntries = useMemo(() => {
    if (!contextMenu || !menuSelection) return [];
    const referenced = contextShownRow && contextColName ? contextShownRow[contextColName] : null;
    const openReference = !contextFk ? undefined
      // A table's: the referenced row, as DBGate's form button opens it.
      : contextColName && contextShownRow && referenced != null && onOpenReference
        ? { label: `Open ${contextFk.table}.${contextFk.column}`, onSelect: () => onOpenReference(contextColName, contextShownRow) }
        : contextCellValue != null && place
          ? { label: `Open ${contextFk.table}.${contextFk.column}`, onSelect: () => openFkTable(contextFk, contextCellValue) }
          : undefined;
    const pressedRow = contextMenu.rowIdx;
    const filters = filtering?.filters;
    const single = menuSelection.single;
    return cellMenuEntries(menuSelection, {
      copyFormat: gridCopy.format, mobile, editable: !cellsReadOnly, canChangeRows, pending: changedRows, hasChanges, canUndo, canRedo,
      canFetchAll: !!onFetchAll && canReadMore && fetchingAll === null,
      filters: filters ? Object.keys(filters.columns).length + (filters.multi?.text.trim() ? 1 : 0) : 0,
    }, {
      openReference,
      refresh: onRefresh,
      fetchAll: () => void onFetchAll?.(),
      copy: gridCopy.copyAs,
      setCopyFormat: gridCopy.setFormat,
      // A phone's form is the row's sheet.
      switchToForm: mobile ? () => setFormRow(pressedRow) : onViewChange && (() => onViewChange("form")),
      togglePanel: sidePanel,
      save: () => void commit(),
      revertRows: revertSelectedRows,
      revertAll,
      deleteRows: deleteSelectedRows,
      insertRow: appendRow,
      cloneRows: cloneSelectedRows,
      setNull: setNullSelected,
      findColumn: onFindColumn,
      // Whole rows lie in every column: hiding them all would leave nothing to see.
      hideColumns: onHideColumns && selectedColumnIndices(gridSelection, columnOrder.length).length > 0 ? hideSelectedColumns : undefined,
      filterSelected: filtering && filterSelectedValues,
      clearFilter: filtering && (() => filtering.onChange(() => NO_FILTERS)),
      undo,
      redo,
      editCell: contextRow && contextColName
        ? () => setTextDialog({ kind: "cell", row: contextRow, column: contextColName, initial: cellText(valueNow(contextRow, contextColName)) })
        : undefined,
      addJson: () => setTextDialog({ kind: "add" }),
      editRowJson: selectedRows[0]
        ? () => setTextDialog({ kind: "row", row: selectedRows[0]!, initial: rowDocumentText(rowValuesNow(selectedRows[0]!), documentColumns) })
        : undefined,
      viewJson: () => {
        setCellDataAsk("jsonExpanded");
        showCellData();
      },
      saveCellToFile: single && contextColName && contextRow ? () => saveCellToFile(single.value, contextColName, contextRow) : undefined,
      showCellData,
      openQuery: onOpenQuery,
      exports: exporter && !exporter.unavailable
        ? [
          ...(exporter.advanced ? [{ kind: "item", label: "Export advanced...", onSelect: exporter.advanced, hint: "Mod+E" } as const] : []),
          ...(exporter.advanced && exporter.run ? [{ kind: "separator" } as const] : []),
          ...(exporter.run ? GRID_EXPORT_FORMATS.map((f): CellMenuEntry => ({ kind: "item", label: f.label, onSelect: () => void exporter.run?.(f.id), disabled: exporter.busy })) : []),
        ]
        : undefined,
      generateSql: onOpenGeneratedSql && selectedTable ? openGenerateSql : undefined,
    });
  }, [
    contextMenu, menuSelection, contextShownRow, contextColName, contextFk, contextCellValue, onOpenReference, place, openFkTable,
    gridCopy.format, gridCopy.copyAs, gridCopy.setFormat, mobile, cellsReadOnly, canChangeRows, changedRows, hasChanges, canUndo, canRedo,
    onFetchAll, canReadMore, fetchingAll, onRefresh, onViewChange, sidePanel, commit, revertSelectedRows, revertAll, deleteSelectedRows,
    appendRow, cloneSelectedRows, setNullSelected, undo, redo, showCellData, filtering, onFindColumn, onHideColumns, gridSelection,
    columnOrder.length, hideSelectedColumns, filterSelectedValues, contextRow, valueNow, selectedRows, rowValuesNow, documentColumns,
    saveCellToFile, onOpenQuery, exporter, onOpenGeneratedSql, selectedTable, openGenerateSql,
  ]);
  // A phone's sheet says what it is for: the table and column, then the row and how many cells.
  const cellMenuTitle = contextColName ? (selectedTable ? `${selectedTable} · ${contextColName}` : contextColName) : "";
  const cellMenuSubtitle = useMemo(() => {
    if (!contextRow) return undefined;
    const isNew = !!pkCol && isNewRowId(String(contextRow[pkCol]));
    const name = isNew ? "New row"
      : keyCols.length ? keyCols.map((c) => `${c} = ${formatCellValue(contextRow[c])}`).join(", ")
        : `Row ${contextMenu!.rowIdx + 1}`;
    return stats && stats.count > 1 ? `${name} · ${stats.count.toLocaleString()} cells` : name;
  }, [contextRow, contextMenu, pkCol, keyCols, stats]);

  // ── The form view's menu: DBGate's form commands, in its order ──
  const [formMenu, setFormMenu] = useState<{ position: { x: number; y: number }; target: FormMenuTarget } | null>(null);
  const openFormMenu = useCallback((position: { x: number; y: number }, target: FormMenuTarget) => setFormMenu({ position, target }), []);
  useEffect(() => { if (!formView) setFormMenu(null); }, [formView]);
  const formMenuItems = useMemo<GridMenuEntry[]>(() => {
    if (!formMenu) return [];
    const { target } = formMenu;
    const kind = filterKinds.get(target.column);
    // What no filter can spell: bytes, JSON, and the value a new row has not been given.
    const filterable = !target.referenced && target.value !== undefined && !isBinaryValue(target.value) && !!kind && canChooseValues(kind);
    const touched = formRowId !== null && revertRows(changeset, new Set([formRowId])) !== changeset;
    const items: GridMenuEntry[] = [];
    if (onRefresh) items.push({ label: "Refresh", icon: RefreshCw, hint: "F5", onSelect: onRefresh });
    if (onViewChange) items.push({ label: "Switch to table", icon: TableSimple, hint: "F4", onSelect: () => onViewChange("table") });
    // The form has no « in a corner to do it with.
    if (sidePanel) items.push({ label: "Toggle left panel", icon: sidePanel.open ? ChevronsLeft : ChevronsRight, hint: formatCombo("Mod+L"), onSelect: sidePanel.onToggle });
    items.push({
      label: "Copy to clipboard", icon: Copy, hint: formatCombo("Mod+C"),
      onSelect: () => {
        void copyToClipboard(target.onName ? target.column : formCopyText(target.value)).then((ok) => {
          if (!ok) toast.error("Could not copy to the clipboard");
        });
      },
    });
    if (onFilterValue || onAddToFilter) items.push("separator");
    if (onFilterValue) {
      items.push({ label: "Filter this value", icon: Filter, hint: formatCombo("Mod+Shift+F"), disabled: !filterable, onSelect: () => onFilterValue(target.column, target.value) });
    }
    if (onAddToFilter) items.push({ label: "Add to filter", icon: ListFilter, disabled: target.referenced, onSelect: () => onAddToFilter(target.column) });
    if (!cellsReadOnly) {
      items.push(
        "separator",
        { label: "Save", icon: Save, hint: formatCombo("Mod+S"), disabled: changedRows === 0, onSelect: () => void commit() },
        { label: "Revert row changes", icon: RotateCcw, hint: formatCombo("Mod+U"), disabled: !touched, onSelect: revertFormRow },
      );
      // Only on a value that can change, as DBGate's: elsewhere the item is not there at all.
      if (formRecord && !target.onName && !target.referenced && canEditCell(formRecord, target.column)) {
        items.push({ label: "Set NULL", icon: XCircle, hint: formatCombo("Mod+0"), onSelect: () => editCells([{ row: formRecord, column: target.column, value: null }]) });
      }
      if (canUndo || canRedo) items.push("separator");
      if (canUndo) items.push({ label: "Undo", icon: Undo2, hint: formatCombo("Mod+Z"), onSelect: undo });
      if (canRedo) items.push({ label: "Redo", icon: Redo2, hint: formatCombo("Mod+Y"), onSelect: redo });
    }
    items.push(
      "separator",
      { label: "First", icon: ArrowPrevious, hint: formatCombo("Mod+Home"), disabled: formAtFirst, onSelect: () => formNavigate("first") },
      { label: "Previous", icon: ChevronLeft, hint: formatCombo("Mod+\u2191"), disabled: formAtFirst, onSelect: () => formNavigate("previous") },
      { label: "Next", icon: ChevronRight, hint: formatCombo("Mod+\u2193"), disabled: formAtLast, onSelect: () => formNavigate("next") },
      { label: "Last", icon: ArrowNext, hint: formatCombo("Mod+End"), disabled: formAtLast, onSelect: () => formNavigate("last") },
    );
    return items;
  }, [
    formMenu, filterKinds, formRowId, changeset, onRefresh, onViewChange, sidePanel, onFilterValue, onAddToFilter, cellsReadOnly, changedRows, commit,
    revertFormRow, formRecord, canEditCell, editCells, canUndo, canRedo, undo, redo, formAtFirst, formAtLast, formNavigate,
  ]);

  if (!columnNames.length) {
    return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
      {loading ? <Loader2 className="size-4 animate-spin" /> : "Select a table"}
    </div>;
  }

  const footInset = scrollbar.height + 8;

  return (
    <div
      ref={containerRef} className="flex flex-col h-full overflow-hidden relative" tabIndex={0} onKeyDown={handleKeyDown}
      onCopy={gridCopy.onCopy} onCut={gridCopy.onCut}
    >
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1" {...pressHandlers}>
          {formView ? (
            <div className="absolute inset-0 flex flex-col">
              <FormView
                table={selectedTable} row={allRows[formIndex]} index={formIndex} rowsShown={allRows.length} loaded={keyedRows.length}
                rowCount={rowCount} schema={schema} pkCol={pkCol} changeset={changeset} canEdit={canEditCell} onEdit={editCells}
                initialField={columnOrder[gridSelection.current?.cell[0] ?? 0] ?? null} onFieldChange={setFormField}
                nameFilter={formNameFilter} onNameFilterChange={onFormNameFilterChange}
                onNavigate={formNavigate} onFilterValue={onFilterValue} onSave={askSave} onMenu={openFormMenu}
                loadReference={loadReference} onOpenReference={onOpenReference} autoFocus={formJustSwitched}
              />
              {allRows.length === 0 && !loading && (
                <GridEmpty message="No rows loaded" top={0}>
                  {onResetFilter && <EmptyAction onClick={onResetFilter}>Reset filter</EmptyAction>}
                  {onOpenQuery && <EmptyAction onClick={onOpenQuery}>Open Query</EmptyAction>}
                </GridEmpty>
              )}
            </div>
          ) : columns.length === 0 ? (
            // DBGate's empty grid when the Columns panel hides every column.
            <GridEmpty message="Every column is hidden" top={0}>
              {onShowAllColumns && <EmptyAction onClick={onShowAllColumns}>Show all columns</EmptyAction>}
            </GridEmpty>
          ) : (
            <>
              <DataEditor ref={gridRef} columns={columns} rows={allRows.length}
                headerHeight={headerHeight} drawHeader={drawHeader} headerIcons={TITLE_SPRITES}
                rowMarkers={{ kind: "clickable-number", width: markerWidth }}
                rangeSelect="multi-rect"
                onVisibleRegionChanged={onVisibleRegionChanged}
                onHeaderClicked={columnSheet ? onHeaderClicked : undefined}
                getCellContent={drawnCellContent} getCellsForSelection={true}
                onCellsEdited={onCellsEdited} onPaste={cellsReadOnly ? false : handlePaste}
                keybindings={KEYBINDINGS} provideEditor={provideEditor}
                getRowThemeOverride={getRowThemeOverride} drawCell={drawCell}
                theme={theme}
                gridSelection={gridSelection} onGridSelectionChange={onGridSelectionChange}
                onColumnResize={onColumnResize} onColumnResizeEnd={onColumnResizeEnd}
                onCellContextMenu={handleCellContextMenu as never}
                onCellClicked={onCellClicked} onMouseMove={onMouseMove}
                smoothScrollX smoothScrollY width="100%" height="100%" />
              <GridHeaderOverlay
                ref={overlayRef} columns={overlayColumns} freezeColumns={0} markerWidth={markerWidth}
                height={headerHeight} rightInset={scrollbar.width} renderSlot={renderHeaderSlot} onRevealColumn={revealColumn}
              />
              {sidePanel && (
                // DBGate's « at the grid's corner: the panel beside the grid, shown or hidden.
                <button
                  type="button" onClick={sidePanel.onToggle} aria-pressed={sidePanel.open}
                  aria-label={`${sidePanel.open ? "Hide" : "Show"} the left panel (Ctrl+L)`} title={`${sidePanel.open ? "Hide" : "Show"} the left panel (Ctrl+L)`}
                  className="absolute left-0 top-0 z-20 grid place-items-center text-text-3 can-hover:hover:text-text"
                  style={{ width: markerWidth, height: titleBand }}
                >
                  <span className="grid size-5 place-items-center rounded can-hover:hover:bg-surface-hover">
                    {sidePanel.open ? <ChevronsLeft className="size-3.5" /> : <ChevronsRight className="size-3.5" />}
                  </span>
                </button>
              )}
              {allRows.length === 0 && !loading && (
                // DBGate's empty grid when nothing matches: what can be done about it.
                <GridEmpty message="No rows loaded" top={headerHeight}>
                  {onResetFilter && <EmptyAction onClick={onResetFilter}>Reset filter</EmptyAction>}
                  {canChangeRows && <EmptyAction onClick={appendRow}>Add row</EmptyAction>}
                  {onOpenQuery && <EmptyAction onClick={onOpenQuery}>Open Query</EmptyAction>}
                </GridEmpty>
              )}
            </>
          )}
          {/* A phone has no room for it beside the thumb bar, as DBGate's mobile layout has none. */}
          {stats && !mobile && !formView && <GridSelectionStats stats={stats} right={scrollbar.width + 8} bottom={footInset} />}
          {rowsLabel && !formView && <GridCornerLabel text={rowsLabel} left={markerWidth + 8} bottom={footInset} />}
          {fetchingAll !== null
            ? <GridLoadingBox text={`Fetching all rows... ${fetchingAll.toLocaleString()} loaded`} cover />
            : loading
              ? <GridLoadingBox text="Loading data" cover />
              : loadingMore && <GridLoadingBox text="Loading data" cover={false} bottom={footInset + 28} />}
        </div>
        {cellDataShown && (
          <CellDataPanel
            source={cellDataSource} width={cellDataWidth} onWidthChange={changeCellDataWidth} floating={floatCellData} onClose={closeCellData}
            ask={cellDataAsk} onAsked={clearCellDataAsk}
          />
        )}
      </div>

      {hasChanges && !onEditStateChange && <GlideSaveBar pendingCount={changedRows} onSave={() => void commit()} onDiscard={revertAll} />}
      {mobile && cellDataSheet && (
        <CellDataSheet source={cellDataSource} onClose={() => setCellDataSheet(false)} ask={cellDataAsk} onAsked={clearCellDataAsk} />
      )}

      {headerMenu && (
        <GlideHeaderMenu
          column={headerMenu.colName} bounds={headerMenu.bounds} sort={sort} fkTable={fkTables.get(headerMenu.colName)}
          onSortChange={onSortChange} onCopyName={() => copyColumnName(headerMenu.colName)} onOpenTable={onOpenTable}
          onClose={() => setHeaderMenu(null)}
        />
      )}

      {contextMenu && contextRow && (
        <CellContextMenu
          entries={cellEntries} position={contextMenu.position} mobile={mobile} title={cellMenuTitle} subtitle={cellMenuSubtitle}
          onClose={() => setContextMenu(null)} returnFocus={focusGrid}
        />
      )}
      {formMenu && <GlideContextMenu position={formMenu.position} items={formMenuItems} onClose={() => setFormMenu(null)} />}

      {cellLookup && (
        <DictionaryLookupDialog
          source={cellLookup.lookup.source} kind={cellLookup.lookup.kind}
          onPick={(value) => editCells([{ row: cellLookup.row, column: cellLookup.column, value }])}
          onClose={() => setCellLookup(null)}
          returnFocus={() => gridRef.current?.focus()}
        />
      )}

      {textDialog && (
        <TextValueDialog
          {...(textDialog.kind === "cell"
            ? {
              title: "Edit cell value", label: `Value of ${textDialog.column}`, jsonTools: true,
              description: `The value of ${textDialog.column}. OK puts it in the change set; Save writes it.`,
            }
            : textDialog.kind === "row"
              ? {
                title: "Edit JSON value", label: "Row as JSON",
                description: "The row as a JSON object. OK puts what changed in the change set; Save writes it.",
                info: "Keys are column names. A column left out keeps its value.",
              }
              : {
                title: "Edit JSON value", label: "New rows as JSON",
                description: "New rows as JSON. OK adds them under the rows loaded; Save writes them.",
                info: "A JSON object adds one row, a list of objects one row each. Keys are column names.",
              })}
          initial={textDialog.kind === "add" ? "" : textDialog.initial}
          onOk={(text) => takeText(textDialog, text)}
          onClose={() => setTextDialog(null)}
          returnFocus={focusGrid}
        />
      )}

      {sqlDialog && onOpenGeneratedSql && (
        <GenerateSqlDialog
          rows={sqlDialog.rows} allColumns={sqlDialog.allColumns} selectedColumns={sqlDialog.columns}
          keyColumns={sqlDialog.target.keyColumns} target={sqlDialog.target}
          onOk={onOpenGeneratedSql} onClose={() => setSqlDialog(null)} returnFocus={focusGrid}
        />
      )}

      {mobile && formRow !== null && (
        <RowFormSheet
          table={selectedTable} rows={allRows} loaded={keyedRows.length} index={formRow} onIndexChange={showFormRow}
          columns={columnOrder} schema={schemaMap} pkCol={pkCol} keyCols={keyCols} changeset={changeset}
          canEdit={canEditCell} onEdit={editCells} pending={changedRows}
          // The sheet goes first: Save changes is a sheet of its own.
          onSave={cellsReadOnly ? undefined : () => { setFormRow(null); void commit(); }}
          onClose={() => setFormRow(null)}
        />
      )}
    </div>
  );
});

/** DBGate's message over an empty grid: at its top left, with what can be done about it under it. */
function GridEmpty({ message, top, children }: { message: string; top: number; children?: React.ReactNode }) {
  return (
    <div className="absolute left-0 z-10 grid max-w-[520px] justify-items-start gap-3 px-4 py-[18px] text-[13px] text-text-2" style={{ top }}>
      <p className="flex items-center gap-2.5"><Info className="size-5 shrink-0 text-primary" aria-hidden />{message}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function EmptyAction({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} className="max-md:h-11 max-md:px-4">
      {children}
    </Button>
  );
}
