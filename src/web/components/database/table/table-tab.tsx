/**
 * DBGate's table data tab: one table's rows, read 100 at a time as they are scrolled to, with
 * DBGate's toolstrip over them and its Columns and Filters panel beside them — or, after F4, one
 * row at a time as DBGate's form, the panel then holding the Column name filter and the filters.
 * On a phone the strip is the ⋯ menu in the tab's header, the panel a bottom sheet, the form the
 * row sheet, and New row and Save sit in the thumb bar.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useAtMostWide } from "@/hooks/use-at-most-wide";
import { targetKey, targetLabel, targetUrl } from "@/lib/db-tabs";
import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import { useDbRowsStatusStore } from "@/stores/db-rows-status-store";
import { useTabLiveContent } from "@/lib/assistant-ui/tab-live-content";
import { READ_TAB_DB_ROWS } from "../../../../shared/assistant-tab-content";
import { slotUnsavedRows } from "@/stores/unsaved-grid-rows-store";
import type { DbObjectKind, DbTableStructure } from "../../../../shared/db-structure";
import { rowsToRecords, type GridRequest, type GridResponse, type GridSort } from "../../../../shared/db-grid";
import type { GridExportFormat } from "../../../../shared/db-grid-export";
import { useDatabase } from "../use-database";
import { useDbRead } from "../use-db-read";
import { useDbTab, type DbTabContext } from "../use-db-tab";
import { GlideDataGrid } from "../glide-data-grid";
import { useGridExport } from "../export-button";
import type { GlideGridHandle, GridColumnSchema, GridEditState, GridFiltering } from "../glide-grid-types";
import type { ReferencedRow } from "../grid/form-view";
import { keyValuesFilter, referencedRowFilters } from "../grid/reference-filter";
import { hasReferences, referenceId, tableReferences, type GridReference, type TableReferences } from "../grid/references";
import { ReferencesSection } from "../grid/references-panel";
import { DETAIL_GRID_SLOT, MasterDetailSplit } from "../grid/master-detail-split";
import { canChooseValues, valueTerm } from "../grid/value-filter-text";
import { isBinaryValue } from "../grid/cell-display";
import {
  NO_FILTERS, TAB_FILTERS_FIELD, filterableColumns, filtersOnColumns, hasFilters, readTabFilters, withColumnFilter,
  withMultiFilter, withTabFilters, type GridFilters,
} from "../grid/grid-filters";
import { useTableFilters } from "../grid/use-table-filters";
import { FilterDialogHost, type OpenFilterDialog } from "../grid/filter-dialog-host";
import { FiltersPanel } from "../grid/filters-panel";
import { FilterChips } from "../grid/filter-chips";
import { FilterSheet, type FilterSheetColumnMenu } from "../grid/filter-sheet";
import { useFilterPickers } from "../grid/use-filter-pickers";
import { ColumnsSection, TableSidePanel } from "../grid/columns-panel";
import { ColumnsSheet } from "../grid/columns-sheet";
import { FetchAllDialog, fetchAllAsks } from "../grid/fetch-all-dialog";
import { useAutoRefresh } from "../grid/refresh-menu";
import {
  CELL_EDITOR_SELECTOR, asElement, isGridKeyCommand, tableKeyCommand, tableKeyPlace, type GridKeyCommand, type TableKeyCommand,
} from "../grid/table-keys";
import { TableActionsMenu, TableThumbBar, TableToolbar, tableButtons, type TableActions } from "../grid/table-toolbar";
import {
  DEFAULT_TABLE_VIEW, FLOATING_PANEL_TAB_WIDTH, TAB_VIEW_FIELD, readTabView, withTabView, type TableViewState,
} from "../grid/table-view-state";
import { setConnectionReadonly } from "../explorer/db-explorer-store";
import { openQueryTab, openReferenceTab, openSqlTab, openStructureTab, openTableTab, type DbRelation } from "../explorer/open-db-tabs";
import { selectTemplate } from "../explorer/sql-templates";
import { DbTabHeader, DbTabState } from "../db-tab-parts";
import { gridExportForm } from "../impexp/impexp-state";
import { openImpExpTab } from "../impexp/open-impexp-tab";

interface Props { metadata?: Record<string, unknown>; tabId?: string }

export function TableTab({ metadata, tabId }: Props) {
  const tab = useDbTab(metadata, tabId);
  if (tab.missing) return <DbTabState empty="This connection no longer exists." />;
  return (
    <TableView
      tab={tab}
      table={typeof metadata?.tableName === "string" ? metadata.tableName : ""}
      // Empty means the connection's own: public on Postgres, the connection's database on MySQL.
      schemaName={typeof metadata?.schemaName === "string" ? metadata.schemaName : ""}
      objectKind={metadata?.objectKind as DbObjectKind | undefined}
      color={tab.conn?.color ?? (metadata?.connectionColor as string | undefined)}
      tabId={tabId}
    />
  );
}

const tabMetadata = (tabId: string) =>
  usePanelStore.getState().getPanelForTab(tabId)?.tabs.find((t) => t.id === tabId)?.metadata;

/** On screen: not a tab the pool parked out of sight, nor one in a hidden panel. */
function isOnScreen(el: HTMLElement | null): boolean {
  if (!el?.isConnected || el.ownerDocument.defaultView?.getComputedStyle(el).visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** A phone's sheets: a filter's (a column's, or the Multi column filter's), or Columns and filters. */
/** `find`: opened by Find column, its search box taking the focus. */
type PhoneSheet = { kind: "filter"; column: string | null } | { kind: "columns"; find?: boolean };

/**
 * One table's data and its toolstrip, wherever the table is: a tab of its own, or the table picked
 * in a database file's tab (`header` false, since that tab names the file itself).
 */
export function TableView({ tab, table, schemaName, objectKind, color, header = true, tabId, shownIn = tabId }: {
  tab: DbTabContext;
  table: string;
  schemaName: string;
  objectKind?: DbObjectKind;
  color?: string | null;
  header?: boolean;
  /**
   * The tab whose metadata keeps the filters and the view (hidden columns, widths), so a reload
   * opens the table as it was left. None for the table picked in a database file's tab: that tab
   * changes table.
   */
  tabId?: string;
  /** The tab the table is shown in, whose "Rows: N" the status bar shows while it is in front. */
  shownIn?: string;
}) {
  const db = useDatabase(tab.target);
  const mobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GlideGridHandle>(null);
  const data = db.tableData;

  // The rows read so far, for the PPM Assistant to read; it takes at most a couple of hundred.
  useTabLiveContent(shownIn, () => ({
    kind: "rows",
    rows: data ? {
      columns: data.columns,
      rows: data.rows.slice(0, READ_TAB_DB_ROWS).map((r) => data.columns.map((c) => r[c])),
      more: data.hasMore || data.rows.length > READ_TAB_DB_ROWS,
    } : null,
  }));

  // "Rows: N" is the status bar's, where DBGate has it: over the grid, it covered the last row read.
  useEffect(() => {
    if (!shownIn || !db.rowCount) return;
    const { file } = useDbRowsStatusStore.getState();
    file(shownIn, { rowCount: db.rowCount, onCountExactly: db.countExactly });
    return () => file(shownIn, null);
  }, [shownIn, db.rowCount, db.countExactly]);

  // ── Filters, kept in the tab ──
  const filterColumns = useMemo(() => filterableColumns(db.schema, tab.dbType), [db.schema, tab.dbType]);
  const [kept] = useState<GridFilters>(() => (tabId ? readTabFilters(tabMetadata(tabId)) : NO_FILTERS));
  const { filters, setFilters, errors: filterErrors, opening, openFailed } = useTableFilters(filterColumns, db.applyFilters, kept);

  const started = useRef(false);
  useEffect(() => {
    // Kept filters are read in each column's syntax, which needs the engine.
    if (started.current || !tab.target || !table || tab.missing || (hasFilters(kept) && !tab.dbType)) return;
    started.current = true;
    const dbType = tab.dbType;
    void db.selectTable(table, schemaName, hasFilters(kept) ? (cols) => opening(filterableColumns(cols, dbType)) : undefined)
      .then((e) => { if (e) openFailed(e); });
  }, [tab.target, tab.missing, tab.dbType, table, schemaName]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tabId) return;
    const metadata = tabMetadata(tabId);
    // A filter on a column the table no longer has is not kept; until the columns are known, all are.
    const next = withTabFilters(metadata, filterColumns.length > 0 ? filtersOnColumns(filters, filterColumns) : filters);
    if (JSON.stringify(next[TAB_FILTERS_FIELD]) === JSON.stringify(metadata?.[TAB_FILTERS_FIELD])) return;
    useTabStore.getState().updateTab(tabId, { metadata: next });
  }, [tabId, filters, filterColumns]);

  // ── The view, kept in the tab: hidden columns, the panel's width, dragged column widths, the form ──
  const [view, setView] = useState<TableViewState>(() => (tabId ? readTabView(tabMetadata(tabId)) : DEFAULT_TABLE_VIEW));
  useEffect(() => {
    if (!tabId) return;
    const metadata = tabMetadata(tabId);
    // Columns the table no longer has are left behind once its columns are known.
    const names = db.schema.length ? new Set(db.schema.map((c) => c.name)) : null;
    const keep = names
      ? {
        ...view,
        hidden: view.hidden.filter((n) => names.has(n)),
        columnWidths: Object.fromEntries(Object.entries(view.columnWidths).filter(([n]) => names.has(n))),
      }
      : view;
    const next = withTabView(metadata, keep);
    if (JSON.stringify(next[TAB_VIEW_FIELD]) === JSON.stringify(metadata?.[TAB_VIEW_FIELD])) return;
    useTabStore.getState().updateTab(tabId, { metadata: next });
  }, [tabId, view, db.schema]);
  const hidden = useMemo(() => new Set(view.hidden), [view.hidden]);
  const hiddenCount = useMemo(() => db.schema.filter((c) => hidden.has(c.name)).length, [db.schema, hidden]);
  const setHidden = useCallback((next: Set<string>) => setView((v) => ({ ...v, hidden: [...next] })), []);
  const hideColumn = useCallback((column: string) => setView((v) => (v.hidden.includes(column) ? v : { ...v, hidden: [...v.hidden, column] })), []);
  const hideColumns = useCallback((columns: string[]) => setView((v) => {
    const more = columns.filter((c) => !v.hidden.includes(c));
    return more.length ? { ...v, hidden: [...v.hidden, ...more] } : v;
  }), []);
  const setColumnWidths = useCallback((columnWidths: Record<string, number>) => setView((v) => ({ ...v, columnWidths })), []);
  const setPanelWidth = useCallback((panelWidth: number) => setView((v) => ({ ...v, panelWidth })), []);

  // ── The panel beside the grid: there unless put away, and in a narrow tab floating and put away ──
  const narrow = useAtMostWide(rootRef, FLOATING_PANEL_TAB_WIDTH);
  // Null until it is shown or hidden by hand; until then the tab's width decides.
  const [panelChoice, setPanelChoice] = useState<boolean | null>(null);
  const panelOpen = panelChoice ?? !narrow;
  const panelAvailable = !mobile && db.schema.length > 0 && !db.driverMissing;
  const togglePanel = useCallback(() => setPanelChoice(!panelOpen), [panelOpen]);
  const closeFloatingPanel = useCallback(() => {
    setPanelChoice(false);
    gridRef.current?.focus();
  }, []);

  // ── The grid's edits and selection, which the toolbar acts on ──
  const [edit, setEdit] = useState<GridEditState | null>(null);
  const editState = data ? edit : null;

  // ── DBGate's form view (F4): a desktop's, in place of the grid; a phone opens the row in its sheet ──
  const formOn = view.form && !mobile;
  const setFormView = useCallback((next: "table" | "form") => {
    setView((v) => (v.form === (next === "form") ? v : { ...v, form: next === "form" }));
  }, []);
  const toggleForm = useCallback(() => {
    if (mobile) gridRef.current?.openRowForm();
    else setView((v) => ({ ...v, form: !v.form }));
  }, [mobile]);
  // DBGate's Column name filter, which marks the fields it matches; the form's alone.
  const [formNameFilter, setFormNameFilter] = useState("");
  // Columns Add to filter gave a box in the Filters panel, there until removed, as DBGate's are.
  const [addedFilters, setAddedFilters] = useState<string[]>([]);
  const removeAddedFilter = useCallback((column: string) => setAddedFilters((a) => a.filter((c) => c !== column)), []);

  // ── Phone sheets, and the dialogs the filters open ──
  const [sheet, setSheet] = useState<PhoneSheet | null>(null);
  // DBGate's Find column: the panel shown, the cursor in its column search — a phone's sheet's, there.
  const [findColumnAsked, setFindColumnAsked] = useState(false);
  const findColumn = useCallback(() => {
    if (mobile) {
      setSheet({ kind: "columns", find: true });
      return;
    }
    setPanelChoice(true);
    setFindColumnAsked(true);
  }, [mobile]);
  const findColumnDone = useCallback(() => setFindColumnAsked(false), []);
  const [filterDialog, setFilterDialog] = useState<OpenFilterDialog | null>(null);
  const pickers = useFilterPickers({
    target: tab.target, dbType: tab.dbType, table: db.selectedTable ?? table, schema: db.selectedSchema,
    columns: filterColumns, tableSchema: db.schema, filters,
  });
  const filtering = useMemo<GridFiltering>(
    () => ({
      filters, columns: filterColumns, onChange: setFilters, errors: filterErrors,
      onDialog: (column, request, returnFocus) => setFilterDialog({ column, request, returnFocus }),
      onChooseValues: (column, returnFocus) => setFilterDialog({ column, request: pickers.chooseValues(column), returnFocus }),
      onLookup: (column, returnFocus) => {
        const request = pickers.lookup(column);
        if (request) setFilterDialog({ column, request, returnFocus });
      },
      onColumnSheet: (column) => setSheet({ kind: "filter", column }),
    }),
    [filters, filterColumns, filterErrors, setFilters, pickers],
  );
  // ⋯ in a foreign key cell's editor: the same lookup as the filter box's, for one row.
  const lookupFor = useCallback((column: string) => {
    const request = pickers.lookup(column);
    return request?.dialog === "lookup" ? { source: request.source, kind: request.kind } : null;
  }, [pickers]);
  const submitFilterDialog = useCallback((column: string | null, text: string) => {
    setFilters((f) => (column === null ? withMultiFilter(f, text) : withColumnFilter(f, column, text)));
  }, [setFilters]);
  const showFilters = filterColumns.length > 0 && !db.driverMissing;
  // The form's Filter this value: the column's filter set to the value, the others kept, as DBGate's.
  const filterValue = useCallback((column: string, value: unknown) => {
    const kind = filterColumns.find((c) => c.name === column)?.kind;
    if (!kind || !canChooseValues(kind) || value === undefined || isBinaryValue(value)) return;
    setFilters((f) => withColumnFilter(f, column, valueTerm(kind, value)));
  }, [filterColumns, setFilters]);
  // The form's Add to filter: an empty box for the column in the panel, which is shown, ready to type in.
  const [focusFilter, setFocusFilter] = useState<string | null>(null);
  const addToFilter = useCallback((column: string) => {
    setAddedFilters((a) => (a.includes(column) ? a : [...a, column]));
    setPanelChoice(true);
    setFocusFilter(column);
  }, []);
  useEffect(() => {
    if (!focusFilter) return;
    setFocusFilter(null);
    const boxes = rootRef.current?.querySelectorAll<HTMLInputElement>("[data-table-panel] input") ?? [];
    [...boxes].find((el) => el.getAttribute("aria-label") === `Filter ${focusFilter}`)?.focus();
  }, [focusFilter]);

  // ── Tabs the view opens ──
  const rel: DbRelation = { schema: schemaName || null, name: table, ...(objectKind ? { kind: objectKind } : {}) };
  const openStructure = () => { if (tab.place) openStructureTab(tab.place, rel); };
  const openSql = () => { if (tab.place) openSqlTab(tab.place, { schema: rel.schema, name: table, kind: objectKind ?? "table" }); };
  const openTable = useCallback((name: string) => {
    if (tab.place) openTableTab(tab.place, { schema: schemaName || null, name });
  }, [tab.place, schemaName]);
  // DBGate's Open Query on an empty grid: the SELECT behind the rows, filters and all.
  const openQuery = tab.place && (data?.sql || tab.dbType)
    ? () => { if (tab.place) openQueryTab(tab.place, data?.sql || selectTemplate({ schema: rel.schema, name: table }, tab.dbType!)); }
    : undefined;
  // DBGate's Generate SQL is a table's: a view's rows are not where an INSERT, UPDATE or DELETE goes.
  const openGeneratedSql = tab.place && (objectKind ?? "table") === "table"
    ? (sql: string) => { if (tab.place) openQueryTab(tab.place, sql); }
    : undefined;

  // ── ⊞ in the form: the row a foreign key refers to, read from its own table ──
  // The referenced tables' columns, read once each; a refresh with the structure reads them again.
  const referencedColumns = useRef(new Map<string, Promise<GridColumnSchema[]>>());
  const loadReference = useCallback(async (column: string, row: Record<string, unknown>): Promise<ReferencedRow> => {
    const fk = db.schema.find((c) => c.name === column)?.fk;
    const target = tab.target;
    if (!fk || !target) throw new Error(`${column} refers to no table`);
    // The key names no schema of its own: the table it refers to is in this table's.
    const schema = db.selectedSchema;
    const scope = schema ? `&schema=${encodeURIComponent(schema)}` : "";
    const key = `${targetKey(target)}\u0000${schema}\u0000${fk.table}`;
    let read = referencedColumns.current.get(key);
    if (!read) {
      read = api.get<GridColumnSchema[]>(targetUrl(target, `/schema?table=${encodeURIComponent(fk.table)}${scope}`));
      referencedColumns.current.set(key, read);
      read.catch(() => referencedColumns.current.delete(key));
    }
    const columns = await read;
    // The key itself is the value on the line above: the rest of the row is what ⊞ adds.
    const shown = columns.filter((c) => c.name !== fk.column);
    const kind = filterableColumns(columns, tab.dbType).find((c) => c.name === fk.column)?.kind ?? "other";
    const filter = keyValuesFilter(fk.column, kind, [row[column]]);
    if (!filter) return { columns: shown, row: null };
    const request: GridRequest = { table: fk.table, ...(schema ? { schema } : {}), filters: [filter.group], limit: 1 };
    const page = await api.post<GridResponse>(targetUrl(target, "/grid"), request);
    return { columns: shown, row: rowsToRecords(page.columns, page.rows).records[0] ?? null };
  }, [db.schema, db.selectedSchema, tab.target, tab.dbType]);
  // The form button on a foreign key: the referenced row as a form, in a new tab filtered to it.
  const openReference = useCallback((column: string, row: Record<string, unknown>) => {
    const fk = db.schema.find((c) => c.name === column)?.fk;
    const kind = filterColumns.find((c) => c.name === column)?.kind ?? "other";
    const kept = fk && referencedRowFilters(fk.column, kind, row[column]);
    if (fk && kept && tab.place) openReferenceTab(tab.place, { schema: schemaName || null, name: fk.table }, kept);
  }, [db.schema, tab.place, filterColumns, schemaName]);

  // ── DBGate's References: a table this one's keys point at, or one whose keys point at it, under the grid ──
  const structure = useDbRead<DbTableStructure>(
    tab.target, table ? `/structure?table=${encodeURIComponent(table)}${schemaName ? `&schema=${encodeURIComponent(schemaName)}` : ""}` : null, shownIn,
  );
  const references = useMemo(() => {
    const refs = structure.data ? tableReferences(structure.data) : null;
    return hasReferences(refs) ? refs : null;
  }, [structure.data]);
  const [reference, setReference] = useState<GridReference | null>(null);
  // The rows selected in the grid, which the reference follows: reported only while one is shown.
  const [masterRows, setMasterRows] = useState<readonly Record<string, unknown>[]>([]);
  const showReference = useCallback((next: GridReference | null) => {
    // The one shown already: DBGate leaves it as it is.
    if (!reference || (next && referenceId(next) === referenceId(reference))) {
      if (!reference) setReference(next);
      return;
    }
    // Its changes go with it: they are saved or discarded first, as nothing else would keep them.
    const unsaved = shownIn ? slotUnsavedRows(shownIn, DETAIL_GRID_SLOT) : 0;
    if (unsaved > 0) {
      toast.info(`Save or discard the changes in ${reference.table} first`, {
        description: `${unsaved.toLocaleString()} changed row${unsaved === 1 ? "" : "s"} there would be lost.`,
      });
      return;
    }
    setReference(next);
  }, [reference, shownIn]);

  const toggleReadonly = useCallback(() => {
    if (!tab.conn) return;
    setConnectionReadonly(tab.conn.id, !tab.readonly)
      .catch((e) => toast.error("Could not change read-only", { description: (e as Error).message }));
  }, [tab.conn, tab.readonly]);

  const copyColumnName = useCallback((name: string) => {
    void copyToClipboard(name).then((ok) => {
      if (ok) toast.success("Column name copied");
      else toast.error("Could not copy the column name");
    });
  }, []);
  const jumpToColumn = useCallback((name: string) => {
    if (hidden.has(name)) {
      toast.info(`${name} is hidden in the grid: tick it in Columns to show it`);
      return;
    }
    gridRef.current?.scrollToColumn(name);
  }, [hidden]);
  const sortChange = useCallback((next: GridSort[]) => { void db.setSort(next); }, [db.setSort]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Refresh, by hand and on a timer ──
  const busy = db.loading || db.loadingMore || db.fetchingAll !== null;
  const auto = useAutoRefresh(db.refreshQuietly, () => (
    // Not while rows are being read, while the tab is out of sight, or under an open cell editor:
    // its value would go to whichever row stands where the edited one did.
    !busy && isOnScreen(rootRef.current) && !rootRef.current?.ownerDocument.activeElement?.closest(CELL_EDITOR_SELECTOR)
  ));
  // The form stays on the row it shows, as DBGate's does; the grid goes back to the top.
  const refresh = useCallback(() => { void db.reload({ keepPlace: formOn }); }, [db.reload, formOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const refreshWithStructure = useCallback(() => {
    referencedColumns.current.clear();
    void db.reload({ structure: true, keepPlace: formOn });
  }, [db.reload, formOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch all: asks first, unless told not to ──
  // Answers whether every row was read: the form's Last goes to the last row once they are.
  const [askFetchAll, setAskFetchAll] = useState(false);
  const fetchAllAnswer = useRef<((done: boolean) => void) | null>(null);
  const answerFetchAll = useCallback((done: boolean) => {
    const answer = fetchAllAnswer.current;
    fetchAllAnswer.current = null;
    answer?.(done);
  }, []);
  const runFetchAll = useCallback((): Promise<boolean> => db.fetchAll().then((done) => {
    if (done) toast.success(`All ${done.rows.length.toLocaleString()} rows loaded`);
    return !!done;
  }), [db.fetchAll]); // eslint-disable-line react-hooks/exhaustive-deps
  const fetchAll = useCallback((): Promise<boolean> => {
    if (!fetchAllAsks()) return runFetchAll();
    // A question nobody answered is answered no.
    answerFetchAll(false);
    setAskFetchAll(true);
    return new Promise((resolve) => { fetchAllAnswer.current = resolve; });
  }, [runFetchAll, answerFetchAll]);

  const where = targetLabel(tab.target, tab.name);
  // ── Export: the columns the grid shows, in its order ──
  const exportColumns = useMemo(() => (data ? data.columns.filter((c) => !hidden.has(c)) : []), [data, hidden]);
  const startExport = useCallback(
    (format: GridExportFormat) => db.startExport(format, exportColumns),
    [db.startExport, exportColumns], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Export advanced...: the Import/Export tab on the grid's query, with the columns it shows when some are hidden.
  const exportAdvanced = useMemo(() => {
    const sql = data?.sql;
    if (mobile || !data || !sql || !tab.target) return undefined;
    const db = { target: tab.target, schema: schemaName || null };
    const shown = exportColumns.length < data.columns.length ? exportColumns : undefined;
    return () => { openImpExpTab(gridExportForm(db, table, sql, shown)); };
  }, [mobile, data, tab.target, schemaName, exportColumns, table]);
  const gridExport = useGridExport(startExport, table, exportColumns.length ? undefined : "Every column is hidden", exportAdvanced);

  const actions: TableActions = {
    table,
    canOpenTabs: !!tab.place,
    onOpenStructure: openStructure,
    onOpenSql: openSql,
    onRefresh: refresh,
    onRefreshWithStructure: refreshWithStructure,
    auto,
    busy,
    idle: !db.selectedTable,
    edit: editState,
    readonly: tab.readonly,
    onSave: () => gridRef.current?.save(),
    onRevert: () => gridRef.current?.revert(),
    onNewRow: () => gridRef.current?.newRow(),
    onDeleteRows: () => gridRef.current?.deleteSelectedRows(),
    onUndo: () => gridRef.current?.undo(),
    onRedo: () => gridRef.current?.redo(),
    export: data ? gridExport : undefined,
    hasMore: !!data?.hasMore && db.fetchingAll === null,
    onFetchAll: fetchAll,
    panel: panelAvailable ? { open: panelOpen, onToggle: togglePanel } : undefined,
    form: data ? { on: formOn, onToggle: toggleForm, onNavigate: (to) => gridRef.current?.formNavigate(to) } : undefined,
    cellData: data ? { open: editState?.cellData ?? false, onToggle: () => gridRef.current?.toggleCellData() } : undefined,
    onToggleReadonly: tab.conn ? toggleReadonly : undefined,
    onCountExactly: db.rowCount?.canCountExactly ? db.countExactly : undefined,
  };

  const floating = narrow;
  const floatingOpen = panelAvailable && panelOpen && floating;
  // The tab in front, where the user works: its grid takes the keys (DBGate's focusOnVisible).
  const inFront = usePanelStore((s) => !!shownIn && s.panels[s.focusedPanelId]?.activeTabId === shownIn);

  // ── DBGate's keys, while focus is in the view ──
  const run = (command: Exclude<TableKeyCommand, GridKeyCommand>) => {
    const shown = tableButtons(actions);
    switch (command) {
      case "refresh": if (!actions.idle) refresh(); break;
      case "refresh-structure": if (!actions.idle) refreshWithStructure(); break;
      case "toggle-auto-refresh": if (!actions.idle) { if (auto.running) auto.stop(); else auto.start(); } break;
      case "save": if (!tab.readonly && (editState?.pending ?? 0) > 0) actions.onSave(); break;
      case "new-row": if (shown.newRow) actions.onNewRow(); break;
      case "delete-rows": if (shown.deleteRows) actions.onDeleteRows(); break;
      // Pressed on a toolbar button rather than in the grid, which takes them itself.
      case "undo": actions.onUndo(); break;
      case "redo": actions.onRedo(); break;
      case "revert-rows": break;
      case "toggle-panel":
        if (mobile) setSheet((s) => (s ? null : { kind: "columns" }));
        else if (panelAvailable) togglePanel();
        break;
      case "clear-filters": setFilters(NO_FILTERS); break;
      case "toggle-form": actions.form?.onToggle(); break;
      case "export-advanced": if (!gridExport.unavailable) gridExport.advanced?.(); break;
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const place = tableKeyPlace(e.currentTarget, e.target);
    if (!place) return;
    if (e.key === "Escape" && floatingOpen && place !== "cell-editor" && !e.defaultPrevented) {
      e.preventDefault();
      closeFloatingPanel();
      return;
    }
    const command = tableKeyCommand(e.nativeEvent, place);
    // The selection's are the grid's, which runs them itself: reaching here, they are the browser's.
    if (!command || (command !== "swallow" && isGridKeyCommand(command))) return;
    // A phone has no Export advanced..., so no key for it either.
    if (command === "export-advanced" && !gridExport.advanced) return;
    e.preventDefault();
    e.stopPropagation();
    if (command !== "swallow") run(command);
  };

  // A click on the grid puts a floating panel away. Only one inside the view: the panel's own
  // menus are portalled elsewhere, yet their clicks reach here through React.
  const onPointerDownCapture = (e: PointerEvent<HTMLDivElement>) => {
    const target = asElement(e.target);
    if (!floatingOpen || !target || !e.currentTarget.contains(target)) return;
    if (target.closest("[data-table-panel]")) return;
    setPanelChoice(false);
  };

  const sheetMenu: FilterSheetColumnMenu = {
    sort: { sort: db.sort, onChange: sortChange },
    onCopyName: copyColumnName,
    onHide: hideColumn,
    onOpenTable: tab.place ? openTable : undefined,
  };

  return (
    <div ref={rootRef} className="@container flex h-full w-full flex-col overflow-hidden" onKeyDown={onKeyDown}>
      {header && (
        <DbTabHeader title={table} subtitle={[where, schemaName, db.rowCount?.text].filter(Boolean).join(" · ")} color={color}>
          {mobile && <TableActionsMenu actions={actions} />}
        </DbTabHeader>
      )}
      {!header && mobile && (
        // A database file's tab names the file and the table itself; the table's own actions are here.
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-soft pr-1 pl-3">
          <span className="min-w-0 flex-1 truncate text-xs text-text-subtle">{db.rowCount?.text}</span>
          <TableActionsMenu actions={actions} />
        </div>
      )}
      {mobile && showFilters && (
        <FilterChips
          filtering={filtering} onOpen={(column) => setSheet({ kind: "filter", column })}
          sort={db.sort} hidden={{ count: hiddenCount, onOpen: () => setSheet({ kind: "columns" }) }}
        />
      )}
      {!mobile && <TableToolbar actions={actions} />}

      <div className="relative flex min-h-0 flex-1 overflow-hidden" onPointerDownCapture={onPointerDownCapture}>
        {panelAvailable && panelOpen && (
          <TableSidePanel width={view.panelWidth} onWidthChange={setPanelWidth} floating={floating} onClose={closeFloatingPanel}>
            <SidePanelSections
              schema={db.schema} hidden={hidden} onHiddenChange={setHidden} onJump={jumpToColumn}
              findColumn={findColumnAsked ? findColumnDone : undefined}
              onOpenTable={tab.place ? openTable : undefined} selected={editState?.selectedColumns}
              filtering={showFilters ? filtering : undefined}
              form={formOn ? { text: formNameFilter, onChange: setFormNameFilter } : undefined}
              added={addedFilters} onRemoveAdded={removeAddedFilter}
              references={references ? { table, refs: references, open: reference, onOpen: showReference } : undefined}
            />
          </TableSidePanel>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {db.driverMissing ? (
              <DbTabState driver={db.driverMissing} />
            ) : data ? (
              <GlideDataGrid
                ref={gridRef}
                columns={data.columns} rows={data.rows}
                schema={db.schema} loading={db.loading}
                rowKey={data.rowKey} onSaveChanges={(changes) => db.saveChanges(changes, tab.place)} readOnly={tab.readonly}
                sort={db.sort} onSortChange={sortChange} viewKey={db.viewKey}
                hasMore={data.hasMore} onLoadMore={db.loadMore} loadingMore={db.loadingMore} fetchingAll={db.fetchingAll}
                hiddenColumns={hidden} onShowAllColumns={() => setHidden(new Set())} onHideColumns={hideColumns}
                onFindColumn={(panelAvailable || mobile) && !formOn ? findColumn : undefined}
                columnWidths={view.columnWidths} onColumnWidthsChange={setColumnWidths}
                onEditStateChange={setEdit} tabId={shownIn}
                sidePanel={panelAvailable ? { open: panelOpen, onToggle: togglePanel } : undefined}
                onResetFilter={hasFilters(filters) ? () => setFilters(NO_FILTERS) : undefined}
                onOpenQuery={openQuery}
                onOpenGeneratedSql={openGeneratedSql}
                exporter={gridExport} startCellDownload={db.startCellDownload} focusOnVisible={inFront}
                onOpenTable={tab.place ? openTable : undefined}
                place={tab.place ?? undefined} selectedTable={db.selectedTable} selectedSchema={db.selectedSchema}
                connectionName={tab.name} dialect={tab.dialect}
                filtering={showFilters ? filtering : undefined}
                lookupFor={tab.target ? lookupFor : undefined}
                view={formOn ? "form" : "table"} onViewChange={setFormView}
                formNameFilter={formNameFilter} onFormNameFilterChange={setFormNameFilter}
                rowCount={db.rowCount} onFetchAll={fetchAll}
                loadReference={tab.target ? loadReference : undefined}
                onOpenReference={tab.place ? openReference : undefined}
                onFilterValue={showFilters ? filterValue : undefined}
                onAddToFilter={showFilters && panelAvailable ? addToFilter : undefined}
                onRefresh={refresh} floatCellData={narrow}
                onSelectedRowsChange={reference ? setMasterRows : undefined}
                rowsLabel={reference ? db.rowCount?.text : undefined}
              />
            ) : (
              <DbTabState loading={db.loading || !db.error} error={db.error} />
            )}
          </div>
          {reference && data && !db.driverMissing && (
            <MasterDetailSplit
              tab={tab} reference={reference} masterRows={masterRows} shownIn={shownIn} narrow={narrow}
              onClose={() => showReference(null)}
            />
          )}
        </div>
      </div>

      {mobile && data && <TableThumbBar actions={actions} onOpenPanel={db.schema.length ? () => setSheet({ kind: "columns" }) : undefined} />}

      {mobile && sheet?.kind === "filter" && showFilters && (
        <FilterSheet filtering={filtering} column={sheet.column} schema={db.schema} menu={sheetMenu} onClose={() => setSheet(null)} />
      )}
      {mobile && sheet?.kind === "columns" && (
        <ColumnsSheet
          table={table} schema={db.schema} hidden={hidden} onHiddenChange={setHidden} onJump={jumpToColumn}
          onOpenTable={tab.place ? openTable : undefined}
          filtering={showFilters ? filtering : undefined}
          onOpenFilter={(column) => setSheet({ kind: "filter", column })}
          references={references ? { refs: references, open: reference, onOpen: showReference } : undefined}
          focusSearch={sheet.find ? () => setSheet({ kind: "columns" }) : undefined}
          onClose={() => setSheet(null)}
        />
      )}
      {askFetchAll && (
        <FetchAllDialog
          onFetch={() => {
            const answer = fetchAllAnswer.current;
            fetchAllAnswer.current = null;
            void runFetchAll().then((done) => answer?.(done));
          }}
          // OK closes the dialog and then fetches: only a close that no fetch follows is a no.
          onClose={() => { setAskFetchAll(false); queueMicrotask(() => answerFetchAll(false)); }}
        />
      )}
      <FilterDialogHost open={filterDialog} onClose={() => setFilterDialog(null)} onSubmit={submitFilterDialog} />
    </div>
  );
}

/**
 * The panel's sections: Columns takes the free height, Filters what it needs, up to half — and
 * References, where the table has any, up to a third under them. The form view's panel has no
 * Columns — the form shows every column — and its Filters start with the Column name filter, as
 * DBGate's do.
 */
function SidePanelSections({
  schema, hidden, onHiddenChange, onJump, findColumn, onOpenTable, selected, filtering, form, added, onRemoveAdded, references,
}: {
  schema: Parameters<typeof ColumnsSection>[0]["schema"];
  hidden: ReadonlySet<string>;
  onHiddenChange: (hidden: Set<string>) => void;
  onJump: (column: string) => void;
  /** Find column was asked: the column search takes the focus, then this is called. */
  findColumn?: () => void;
  onOpenTable?: (table: string) => void;
  selected?: readonly string[];
  filtering?: GridFiltering;
  form?: { text: string; onChange: (text: string) => void };
  added: readonly string[];
  onRemoveAdded: (column: string) => void;
  references?: { table: string; refs: TableReferences; open: GridReference | null; onOpen: (reference: GridReference) => void };
}) {
  const [columnsCollapsed, setColumnsCollapsed] = useState(false);
  const [referencesCollapsed, setReferencesCollapsed] = useState(false);
  const lit = useMemo(() => new Set(selected), [selected]);
  const referencesSection = references && (
    <div className="flex max-h-[30%] min-h-0 shrink-0 flex-col border-t border-border">
      <ReferencesSection
        table={references.table} references={references.refs} open={references.open} onOpen={references.onOpen}
        collapsed={referencesCollapsed} onCollapsedChange={setReferencesCollapsed}
      />
    </div>
  );
  if (form) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {filtering && (
          <div className="flex min-h-0 flex-1 flex-col">
            <FiltersPanel filtering={filtering} schema={schema} nameFilter={form} added={added} onRemoveAdded={onRemoveAdded} />
          </div>
        )}
        {referencesSection}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ColumnsSection
        schema={schema} hidden={hidden} onHiddenChange={onHiddenChange} onJump={onJump} onOpenTable={onOpenTable}
        selected={lit} collapsed={columnsCollapsed} onCollapsedChange={setColumnsCollapsed} focusSearch={findColumn}
      />
      {filtering && (
        <div className={columnsCollapsed ? "flex min-h-0 flex-1 flex-col" : cn("flex min-h-0 shrink-0 flex-col border-t border-border", references ? "max-h-[40%]" : "max-h-[45%]")}>
          <FiltersPanel filtering={filtering} schema={schema} added={added} onRemoveAdded={onRemoveAdded} />
        </div>
      )}
      {referencesSection}
    </div>
  );
}
