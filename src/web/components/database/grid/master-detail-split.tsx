/**
 * DBGate's master / detail: a table from the References list shown under the grid, holding only
 * the rows that belong to the rows selected there, and following the selection as it moves. The
 * header reads the join out — `orders [user_id] = master [id]` — with Close beside it. Below it is
 * the table grid every other tab has: filter row, sort, editing, its own Save bar (the toolbar
 * above is the master's), its own "Rows: N". A phone gives it the lower 45% of the screen.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Link } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { FilterGroup, GridSort } from "../../../../shared/db-grid";
import { useDatabase, type DbColumnInfo } from "../use-database";
import { useDbRead } from "../use-db-read";
import type { DbTabContext } from "../use-db-tab";
import { GlideDataGrid } from "../glide-data-grid";
import type { GlideGridHandle, GridFiltering } from "../glide-grid-types";
import { DbTabState } from "../db-tab-parts";
import { linkButtonClass } from "../explorer/tree-parts";
import { openQueryTab, openReferenceTab, openTableTab } from "../explorer/open-db-tabs";
import { selectTemplate } from "../explorer/sql-templates";
import { FilterDialogHost, type OpenFilterDialog } from "./filter-dialog-host";
import { NO_FILTERS, filterableColumns, hasFilters, withColumnFilter, withMultiFilter, type FilterRequest } from "./grid-filters";
import { referencedRowFilters } from "./reference-filter";
import { detailKeyFilters, referenceId, referenceJoin, type GridReference } from "./references";
import { isGridKeyCommand, tableKeyCommand, tableKeyPlace } from "./table-keys";
import { useFilterPickers } from "./use-filter-pickers";
import { useTableFilters } from "./use-table-filters";

/** The slot the detail's unsaved rows are counted under in its tab (`unsaved-grid-rows-store.ts`). */
export const DETAIL_GRID_SLOT = "detail";

export function MasterDetailSplit({ tab, reference, masterRows, shownIn, narrow, onClose }: {
  tab: DbTabContext;
  reference: GridReference;
  /** The rows selected in the grid above, as they were read. */
  masterRows: readonly Record<string, unknown>[];
  /** The tab both grids are in. */
  shownIn?: string;
  /** A narrow tab's: the Cell data view floats over the grid. */
  narrow: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const join = referenceJoin(reference);
  return (
    <>
      <div aria-hidden className="h-[5px] shrink-0 border-y border-border bg-panel" />
      <section aria-labelledby={titleId} className="flex min-h-[150px] shrink-0 grow-0 basis-[42%] flex-col bg-panel-2 max-md:basis-[45%]">
        <div className="flex h-[30px] shrink-0 items-center gap-1.5 border-b border-border-soft bg-panel px-2.5 text-xs text-text-2 max-md:h-11 max-md:text-[13px]">
          <Link className="size-3.5 shrink-0 text-info" aria-hidden />
          <h3 id={titleId} className="min-w-0 truncate font-normal">
            <b className="font-semibold text-text">{join.table}</b> [{join.detail}] = master [{join.master}]
            {masterRows.length === 0 && <span className="text-text-3"> · select a row in the grid above</span>}
          </h3>
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label={`Close ${join.table}`} className={cn(linkButtonClass, "shrink-0 max-md:min-w-11")}>
            Close
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <DetailGrid key={referenceId(reference)} tab={tab} reference={reference} masterRows={masterRows} shownIn={shownIn} narrow={narrow} />
        </div>
      </section>
    </>
  );
}

const NO_REQUEST: FilterRequest = { filters: [], anyColumn: [] };

function DetailGrid({ tab, reference, masterRows, shownIn, narrow }: {
  tab: DbTabContext;
  reference: GridReference;
  masterRows: readonly Record<string, unknown>[];
  shownIn?: string;
  narrow: boolean;
}) {
  const db = useDatabase(tab.target);
  const mobile = useIsMobile();
  const gridRef = useRef<GlideGridHandle>(null);
  const schemaName = reference.schema ?? "";
  const scope = schemaName ? `&schema=${encodeURIComponent(schemaName)}` : "";
  // Read before any row is: they say how the key is written, and head the grid while no master row is selected.
  const columnsRead = useDbRead<DbColumnInfo[]>(tab.target, `/schema?table=${encodeURIComponent(reference.table)}${scope}`, shownIn);
  const schema = db.schema.length ? db.schema : columnsRead.data ?? [];
  const filterColumns = useMemo(() => filterableColumns(schema, tab.dbType), [schema, tab.dbType]);

  // What the master's selection asks of the rows here; null when no row of this table can belong to it.
  const keys = useMemo(() => {
    if (!filterColumns.length) return null;
    const kindOf = (column: string) => filterColumns.find((c) => c.name === column)?.kind ?? "other";
    return detailKeyFilters(reference, masterRows, kindOf);
  }, [reference, masterRows, filterColumns]);
  const keysKey = keys ? JSON.stringify(keys) : null;
  const keysRef = useRef<FilterGroup[] | null>(keys);
  keysRef.current = keys;

  // The rows here are the key's and the filter row's together; the filter row shows only its own.
  const ownRef = useRef<FilterRequest>(NO_REQUEST);
  const started = useRef(false);
  // The latest read failed: the rows still on hand are another selection's, or another filter's.
  const [failed, setFailed] = useState(false);
  const readSeq = useRef(0);
  const read = useCallback(async (keyGroups: readonly FilterGroup[]) => {
    const own = ownRef.current;
    const request: FilterRequest = { filters: [...keyGroups, ...own.filters], anyColumn: own.anyColumn };
    const seq = ++readSeq.current;
    let e: Error | null;
    if (started.current) e = await db.applyFilters(request);
    else {
      started.current = true;
      e = await db.selectTable(reference.table, schemaName, () => request);
    }
    if (seq === readSeq.current) setFailed(e !== null);
    return e;
  }, [db.applyFilters, db.selectTable, reference.table, schemaName]); // eslint-disable-line react-hooks/exhaustive-deps
  const hadRows = useRef(false);
  hadRows.current = db.tableData !== null;
  useEffect(() => {
    if (!keysKey) return;
    const shown = hadRows.current;
    void read(JSON.parse(keysKey) as FilterGroup[]).then((e) => {
      // A first read that fails says why in the grid's place; later ones would leave it unsaid.
      if (e && shown) toast.error(`Could not read ${reference.table}`, { description: e.message });
    });
  }, [keysKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const applyOwn = useCallback((request: FilterRequest) => {
    ownRef.current = request;
    const keyGroups = keysRef.current;
    return keyGroups ? read(keyGroups) : Promise.resolve(null);
  }, [read]);
  const { filters, setFilters, errors } = useTableFilters(filterColumns, applyOwn);

  const [filterDialog, setFilterDialog] = useState<OpenFilterDialog | null>(null);
  const pickers = useFilterPickers({
    target: tab.target, dbType: tab.dbType, table: reference.table, schema: schemaName,
    columns: filterColumns, tableSchema: schema, filters, fixed: keys ?? undefined,
  });
  const filtering = useMemo<GridFiltering>(() => ({
    filters, columns: filterColumns, onChange: setFilters, errors,
    onDialog: (column, request, returnFocus) => setFilterDialog({ column, request, returnFocus }),
    onChooseValues: (column, returnFocus) => setFilterDialog({ column, request: pickers.chooseValues(column), returnFocus }),
    onLookup: (column, returnFocus) => {
      const request = pickers.lookup(column);
      if (request) setFilterDialog({ column, request, returnFocus });
    },
  }), [filters, filterColumns, errors, setFilters, pickers]);
  const lookupFor = useCallback((column: string) => {
    const request = pickers.lookup(column);
    return request?.dialog === "lookup" ? { source: request.source, kind: request.kind } : null;
  }, [pickers]);
  const submitFilterDialog = useCallback((column: string | null, text: string) => {
    setFilters((f) => (column === null ? withMultiFilter(f, text) : withColumnFilter(f, column, text)));
  }, [setFilters]);

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const sortChange = useCallback((next: GridSort[]) => { void db.setSort(next); }, [db.setSort]); // eslint-disable-line react-hooks/exhaustive-deps
  const openTable = useCallback((name: string) => {
    if (tab.place) openTableTab(tab.place, { schema: reference.schema, name });
  }, [tab.place, reference.schema]);
  const openReference = useCallback((column: string, row: Record<string, unknown>) => {
    const fk = schema.find((c) => c.name === column)?.fk;
    const kind = filterColumns.find((c) => c.name === column)?.kind ?? "other";
    const kept = fk && referencedRowFilters(fk.column, kind, row[column]);
    if (fk && kept && tab.place) openReferenceTab(tab.place, { schema: reference.schema, name: fk.table }, kept);
  }, [schema, filterColumns, tab.place, reference.schema]);

  // ── DBGate's keys act on the grid they are pressed in: here, this one ──
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const place = tableKeyPlace(e.currentTarget, e.target);
    const command = place && tableKeyCommand(e.nativeEvent, place);
    // The panel beside both grids is the master's to show or hide; the selection's keys are the
    // grid's, which runs them itself.
    if (!command || command === "toggle-panel" || (command !== "swallow" && isGridKeyCommand(command))) return;
    e.preventDefault();
    e.stopPropagation();
    switch (command) {
      case "refresh": if (keys) void db.reload(); break;
      case "refresh-structure":
        void columnsRead.reload();
        if (keys) void db.reload({ structure: true });
        break;
      case "save": if (!tab.readonly) gridRef.current?.save(); break;
      case "new-row": if (keys) gridRef.current?.newRow(); break;
      case "delete-rows": gridRef.current?.deleteSelectedRows(); break;
      case "undo": gridRef.current?.undo(); break;
      case "redo": gridRef.current?.redo(); break;
      case "clear-filters": setFilters(NO_FILTERS); break;
      // No auto refresh, Revert row changes on a button, or form here.
      default: break;
    }
  };

  const data = db.tableData;
  if (columnsRead.error && !schema.length) return <DbTabState error={columnsRead.error} />;
  if (db.error && !data) return <DbTabState error={db.error} />;
  if (!schema.length) return <DbTabState loading />;

  // No master row, or one whose key is NULL: no row here belongs to it, and none is read.
  const waiting = !keys;
  const openQuery = tab.place && !waiting && (data?.sql || tab.dbType)
    ? () => { if (tab.place) openQueryTab(tab.place, data?.sql || selectTemplate({ schema: reference.schema, name: reference.table }, tab.dbType!)); }
    : undefined;

  return (
    <div className="absolute inset-0" onKeyDown={onKeyDown}>
      <GlideDataGrid
        ref={gridRef}
        columns={data?.columns ?? schema.map((c) => c.name)} rows={waiting || failed || !data ? [] : data.rows}
        schema={schema} loading={!waiting && (db.loading || !data)}
        rowKey={data?.rowKey} onSaveChanges={(changes) => db.saveChanges(changes, tab.place)} readOnly={tab.readonly}
        // Rows cannot be added for a master row that is not there.
        editOnly={waiting}
        sort={db.sort} onSortChange={sortChange} viewKey={waiting ? "waiting" : db.viewKey}
        hasMore={!waiting && !!data?.hasMore} onLoadMore={db.loadMore} loadingMore={db.loadingMore} fetchingAll={db.fetchingAll}
        columnWidths={columnWidths} onColumnWidthsChange={setColumnWidths}
        tabId={shownIn} tabSlot={DETAIL_GRID_SLOT} rowsLabel={waiting ? "Rows: 0" : failed ? undefined : db.rowCount?.text}
        onResetFilter={!waiting && hasFilters(filters) ? () => setFilters(NO_FILTERS) : undefined}
        onOpenQuery={openQuery}
        onOpenTable={tab.place ? openTable : undefined}
        place={tab.place ?? undefined} selectedTable={reference.table} selectedSchema={schemaName}
        connectionName={tab.name} dialect={tab.dialect}
        filtering={mobile ? undefined : filtering}
        lookupFor={tab.target ? lookupFor : undefined}
        onOpenReference={tab.place ? openReference : undefined}
        startCellDownload={db.startCellDownload}
        floatCellData={narrow}
      />
      <FilterDialogHost open={filterDialog} onClose={() => setFilterDialog(null)} onSubmit={submitFilterDialog} />
    </div>
  );
}
