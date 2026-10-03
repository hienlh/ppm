import { useState, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { missingDbDriverOf, type MissingDbDriver } from "@/lib/db-drivers";
import { useDbDriverInstalled } from "@/hooks/use-db-driver-installed";
import { targetKey, targetUrl, type DbTarget } from "@/lib/db-tabs";
import {
  GRID_MAX_LIMIT, rowsToRecords,
  type GridCountRequest, type GridCountResponse, type GridRequest, type GridResponse, type GridSort, type QueryRecordsResult,
} from "../../../shared/db-grid";
import type { RowKey } from "../../../shared/db-changeset";
import type { GridCellRequest, GridExportFormat, GridExportRequest, GridExportTicket } from "../../../shared/db-grid-export";
import type { GridChanges, RowCountView } from "./glide-grid-types";
import type { FilterRequest } from "./grid/grid-filters";
import { requestGridSave } from "./grid/grid-save-store";
import type { DbTabPlace } from "./explorer/open-db-tabs";

export interface DbTableInfo { name: string; schema: string; rowCount: number }
export interface DbColumnInfo { name: string; type: string; nullable: boolean; pk: boolean; defaultValue: string | null; autoIncrement: boolean; fk?: { table: string; column: string } | null }
export type DbQueryResult = QueryRecordsResult;

/** The rows read so far, from the first one on: DBGate reads a table a page at a time as it is scrolled. */
export interface DbTableData {
  columns: string[];
  rows: Record<string, unknown>[];
  /** At least one row exists past the loaded ones. */
  hasMore: boolean;
  /** The server's rendering of the SELECT behind these rows, without paging. */
  sql?: string;
  /** Identifies the table + filters these rows came from, to match them with their row count. */
  countKey?: string;
  /** Columns that address a row in a changeset; empty when rows cannot be addressed. */
  rowKey?: string[];
}

/** Rows read at a time, as they are scrolled to: DBGate's page size. */
export const GRID_PAGE_SIZE = 100;

/** Rows each request of a Fetch all asks for: few requests, each answered quickly. */
export const FETCH_ALL_CHUNK = 5_000;

const NO_FILTER_REQUEST: FilterRequest = { filters: [], anyColumn: [] };

/** Row count of one table + filter combination, fetched apart from its rows. */
interface RowCount {
  key: string;
  count: number | null;
  estimate: number | null;
  pending: boolean;
  /** The count gave up at its time limit. */
  timedOut?: boolean;
  /** Why it could not be counted. */
  failed?: string;
}

/** SessionStorage cache key for a table's plain first rows; `db` is the database the tab names, empty for the connection's own. */
function cacheKey(db: string, table: string, schema: string) {
  return `ppm-db-${db}-${schema}.${table}-p1`;
}

const schemaPath = (table: string, schema: string) => `/schema?table=${encodeURIComponent(table)}${schema ? `&schema=${encodeURIComponent(schema)}` : ""}`;

function readCache(db: string, table: string, schema: string): { data: DbTableData; cols: DbColumnInfo[] } | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(db, table, schema));
    const cached = raw ? JSON.parse(raw) as { data: DbTableData; cols: DbColumnInfo[] } : null;
    // A cache written before rows were read by scrolling has no `hasMore`.
    return cached && typeof cached.data?.hasMore === "boolean" ? cached : null;
  } catch { return null; }
}

function writeCache(db: string, table: string, schema: string, data: DbTableData, cols: DbColumnInfo[]) {
  try { sessionStorage.setItem(cacheKey(db, table, schema), JSON.stringify({ data, cols })); } catch { /* quota */ }
}

const fmt = (n: number) => n.toLocaleString();

/** "Rows: N" for the rows loaded and the count known of them. */
export function rowCountView(data: DbTableData | null, count: RowCount | null): RowCountView | null {
  if (!data) return null;
  const loaded = data.rows.length;
  // Every row is loaded: that is the count.
  if (!data.hasMore) return { text: `Rows: ${fmt(loaded)}`, counting: false, canCountExactly: false, total: { kind: "exact", count: loaded } };
  const c = count?.key === data.countKey ? count : null;
  if (c?.count != null) {
    const exact = Math.max(c.count, loaded);
    return { text: `Rows: ${fmt(exact)}`, counting: false, canCountExactly: false, total: { kind: "exact", count: exact } };
  }
  // An estimate is the database's statistics; only worth showing when it says more than is loaded.
  const estimate = c?.estimate != null && c.estimate > loaded ? c.estimate : null;
  if (c && !c.pending && (c.timedOut || c.failed)) {
    return {
      text: estimate !== null ? `Rows: ~${fmt(estimate)}` : "Rows: Many",
      counting: false,
      canCountExactly: true,
      title: c.failed
        ? `The rows could not be counted: ${c.failed}. Click to try again.`
        : "Counting took too long, so this is not exact. Click to count every row.",
      total: estimate !== null ? { kind: "estimate", count: estimate } : { kind: "many" },
    };
  }
  return {
    text: estimate !== null ? `Rows: ~${fmt(estimate)}` : `Rows: ${fmt(loaded)}+`,
    counting: !!c?.pending,
    canCountExactly: false,
    title: estimate !== null ? "The database's estimate, until the rows are counted" : "Rows loaded so far, until they are counted",
    total: estimate !== null ? { kind: "estimate", count: estimate } : { kind: "atLeast", count: loaded },
  };
}

interface ReadOptions {
  table?: string;
  tableSchema?: string;
  sort?: GridSort[];
  /** Read the table's columns again: DBGate's Refresh with structure. */
  structure?: boolean;
  /** An auto refresh: no loading box, and nothing said when it fails (the caller is told). */
  silent?: boolean;
  /** Read again as many rows as are loaded, so the grid stays where it is (after a save, on an auto refresh). */
  keepLoaded?: boolean;
  /** Count the rows again although the table and filters are the same: rows were added or removed. */
  recount?: boolean;
}

/**
 * One table's rows, row count and edits, read through `/api/db/connections/:id/…` for any engine
 * — a saved connection, one of its server's other databases, or a database file (see `targetUrl`).
 * The first 100 rows come first and the next 100 each time the grid is scrolled to the end, as in
 * DBGate; Fetch all reads the rest. No auto-fetch on mount — the tab calls selectTable() to start.
 */
export function useDatabase(target: DbTarget | null) {
  const at = useCallback((path: string) => (target ? targetUrl(target, path) : ""), [target]);
  const cacheDb = target ? targetKey(target) : "";
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  // Empty means the connection's own schema, which the server resolves per engine.
  const [selectedSchema, setSelectedSchema] = useState("");
  // Read by every fetch, so one started by a scroll or a timer reads the table the view shows now.
  const viewRef = useRef<{ table: string; schema: string } | null>(null);
  const [tableData, setTableData] = useState<DbTableData | null>(null);
  const dataRef = useRef<DbTableData | null>(null);
  const [schema, setSchema] = useState<DbColumnInfo[]>([]);
  // The table the columns in `schema` were read for: rows alone are read on every other refresh.
  const schemaForRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // How many rows a Fetch all has loaded so far, while it runs.
  const [fetchingAll, setFetchingAll] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set while the connection's driver is not installed: the viewer offers Install instead of data.
  const [driverMissing, setDriverMissing] = useState<MissingDbDriver | null>(null);
  // The call that found the driver missing, run again once it is installed.
  const retryRef = useRef<(() => void) | null>(null);
  // DBGate sorts by several columns, in order; empty is the table's own order.
  const [sort, setSortState] = useState<GridSort[]>([]);
  const sortRef = useRef<GridSort[]>([]);
  // Header filters of the table view. A ref so a fetch started by a sort or a scroll uses the
  // filters in force rather than a stale closure.
  const filtersRef = useRef<FilterRequest>(NO_FILTER_REQUEST);
  // Bumped whenever the rows shown start over (another table, filters, sort, a refresh): only the
  // latest read may show its rows, and rows appended for an earlier one are dropped.
  const fetchSeqRef = useRef(0);
  // Rows are appended one request at a time, in order, so two never read the same offset.
  const appendQueueRef = useRef<Promise<void>>(Promise.resolve());
  // The read the queued "load more" belongs to: the grid asks on every scroll at the end.
  const moreQueuedRef = useRef<number | null>(null);
  // The count arrives after the rows, and only when the table or filters change.
  const [rowCount, setRowCount] = useState<RowCount | null>(null);
  const rowCountRef = useRef<RowCount | null>(null);
  const countSeqRef = useRef(0);
  // Bumped when rows read from the first one replace those shown: the grid goes back to its top.
  const [viewKey, setViewKey] = useState(0);

  const showData = useCallback((data: DbTableData) => {
    dataRef.current = data;
    setTableData(data);
  }, []);
  const settleCount = useCallback((count: RowCount) => {
    rowCountRef.current = count;
    setRowCount(count);
  }, []);
  /** Every row is loaded, so their number is the count: no COUNT(*) needed. */
  const countIsLoaded = useCallback((data: DbTableData) => {
    countSeqRef.current++;
    if (data.countKey) settleCount({ key: data.countKey, count: data.rows.length, estimate: null, pending: false });
  }, [settleCount]);

  const requestCount = useCallback((request: GridCountRequest, key: string) => {
    const seq = ++countSeqRef.current;
    const earlier = rowCountRef.current?.key === key ? rowCountRef.current : null;
    settleCount({ key, count: null, estimate: earlier?.estimate ?? null, pending: true });
    api.post<GridCountResponse>(at("/grid/count"), {
      table: request.table, schema: request.schema, filters: request.filters, anyColumn: request.anyColumn,
      ...(request.exact ? { exact: true } : {}),
    } satisfies GridCountRequest)
      .then((r) => {
        if (seq !== countSeqRef.current) return;
        settleCount({ key, count: r.count, estimate: r.estimate, pending: false, timedOut: r.timedOut });
      })
      .catch((e: unknown) => {
        if (seq !== countSeqRef.current) return;
        // The rows still read from the lower bound; the label says the count failed and offers it again.
        settleCount({ key, count: null, estimate: earlier?.estimate ?? null, pending: false, failed: (e as Error).message });
      });
  }, [at, settleCount]);

  /** The request for the rows the view shows, from `offset`. */
  const viewRequest = useCallback((offset: number, limit: number, view = viewRef.current, sortBy = sortRef.current): GridRequest | null => {
    if (!view) return null;
    const { filters, anyColumn } = filtersRef.current;
    return { table: view.table, schema: view.schema, filters, anyColumn, sort: sortBy, offset, limit };
  }, []);

  /**
   * DBGate's Export: every row the view's filters and sort select, not only those loaded, with
   * `columns` in their order. Answers the ticket the browser downloads the file with — the server
   * reads the rows as it goes — or null while no table is shown.
   */
  const startExport = useCallback((format: GridExportFormat, columns: string[]): Promise<GridExportTicket | null> => {
    const view = viewRef.current;
    if (!view) return Promise.resolve(null);
    const { filters, anyColumn } = filtersRef.current;
    return api.post<GridExportTicket>(at("/grid/export"), {
      table: view.table, schema: view.schema, filters, anyColumn, sort: sortRef.current, columns, format,
    } satisfies GridExportRequest);
  }, [at]);

  /**
   * Save cell to file for bytes the grid has only the start of: the shown table's `column` in the
   * row `key` names, read whole by the server. Answers the ticket its file downloads with, named
   * `fileName`, or null while no table is shown.
   */
  const startCellDownload = useCallback((column: string, key: RowKey, fileName: string): Promise<GridExportTicket | null> => {
    const view = viewRef.current;
    if (!view) return Promise.resolve(null);
    return api.post<GridExportTicket>(at("/grid/cell"), {
      table: view.table, schema: view.schema, column, key, fileName,
    } satisfies GridCellRequest);
  }, [at]);

  /**
   * Read the rows from the first one: on opening a table, after a change of filters or sort, on
   * a refresh. Answers the error when they could not be read (a silent read says it to no one else).
   */
  const readFirst = useCallback(async (opts: ReadOptions = {}): Promise<Error | null> => {
    const view = opts.table !== undefined ? { table: opts.table, schema: opts.tableSchema ?? "" } : viewRef.current;
    if (!view || !target) return null;
    const seq = ++fetchSeqRef.current;
    moreQueuedRef.current = null;
    setFetchingAll(null);
    if (!opts.silent) setLoading(true);
    const sortBy = opts.sort ?? sortRef.current;
    const loaded = dataRef.current?.rows.length ?? 0;
    const limit = opts.keepLoaded ? Math.min(Math.max(loaded, GRID_PAGE_SIZE), GRID_MAX_LIMIT) : GRID_PAGE_SIZE;
    const request = viewRequest(0, limit, view, sortBy)!;
    const { filters, anyColumn } = filtersRef.current;
    const countKey = JSON.stringify([view.table, view.schema, filters, anyColumn]);
    const tableKey = JSON.stringify([view.table, view.schema]);
    const readColumns = opts.structure || schemaForRef.current !== tableKey;
    try {
      const [grid, cols] = await Promise.all([
        api.post<GridResponse>(at("/grid"), request),
        readColumns ? api.get<DbColumnInfo[]>(at(schemaPath(view.table, view.schema))) : Promise.resolve(null),
      ]);
      if (seq !== fetchSeqRef.current) return null;
      setDriverMissing(null);
      setError(null);
      const { keys, records } = rowsToRecords(grid.columns, grid.rows);
      const data: DbTableData = { columns: keys, rows: records, hasMore: grid.hasMore, sql: grid.sql, countKey, rowKey: grid.rowKey };
      showData(data);
      // Rows read again where they were (a save, an auto refresh) keep the grid where it is.
      if (!opts.keepLoaded) setViewKey((k) => k + 1);
      if (cols) {
        setSchema(cols);
        schemaForRef.current = tableKey;
      }
      // The cache only stands in for the plain first view of a table.
      if (filters.length === 0 && anyColumn.length === 0 && sortBy.length === 0 && limit === GRID_PAGE_SIZE && cols) {
        writeCache(cacheDb, view.table, view.schema, data, cols);
      }
      if (!grid.hasMore) countIsLoaded(data);
      else if (opts.recount || rowCountRef.current?.key !== countKey) requestCount(request, countKey);
      return null;
    } catch (e) {
      if (seq !== fetchSeqRef.current) return null;
      if (opts.silent) return e as Error;
      setError((e as Error).message);
      const driver = missingDbDriverOf(e);
      setDriverMissing(driver);
      retryRef.current = driver ? () => { void readFirst({ ...opts, table: view.table, tableSchema: view.schema }); } : null;
      return e as Error;
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [at, target, cacheDb, viewRequest, showData, countIsLoaded, requestCount]);

  /** Read `limit` more rows after the loaded ones and append them; false when the view changed meanwhile. */
  const appendRows = useCallback(async (seq: number, limit: number): Promise<boolean> => {
    const data = dataRef.current;
    if (seq !== fetchSeqRef.current || !data?.hasMore) return false;
    const request = viewRequest(data.rows.length, limit);
    if (!request) return false;
    const grid = await api.post<GridResponse>(at("/grid"), request);
    const current = dataRef.current;
    if (seq !== fetchSeqRef.current || !current) return false;
    const { records } = rowsToRecords(grid.columns, grid.rows);
    const next: DbTableData = { ...current, rows: [...current.rows, ...records], hasMore: grid.hasMore };
    showData(next);
    if (!grid.hasMore) countIsLoaded(next);
    return true;
  }, [at, viewRequest, showData, countIsLoaded]);

  /** One request at a time, in the order asked: each reads from where the one before it stopped. */
  const enqueue = useCallback((op: () => Promise<void>) => {
    const run = appendQueueRef.current.then(op);
    appendQueueRef.current = run.catch(() => {});
    return run;
  }, []);

  /** The next 100 rows: the grid was scrolled to its last row. Asked again while it runs, it does nothing. */
  const loadMore = useCallback(() => {
    const seq = fetchSeqRef.current;
    if (!dataRef.current?.hasMore || moreQueuedRef.current === seq) return;
    moreQueuedRef.current = seq;
    setLoadingMore(true);
    void enqueue(async () => {
      try {
        await appendRows(seq, GRID_PAGE_SIZE);
      } catch (e) {
        if (seq === fetchSeqRef.current) toast.error("Could not load more rows", { description: (e as Error).message });
      } finally {
        if (moreQueuedRef.current === seq) {
          moreQueuedRef.current = null;
          setLoadingMore(false);
        }
      }
    });
  }, [enqueue, appendRows]);

  /**
   * DBGate's Fetch all: every remaining row, a few thousand per request, counting as they arrive.
   * Answers the rows once every one is loaded — read from the ref, since the state holding them has
   * not been rendered yet when this resolves — and null when it stopped short or the view started over.
   */
  const fetchAll = useCallback((): Promise<DbTableData | null> => {
    const seq = fetchSeqRef.current;
    if (!dataRef.current?.hasMore) return Promise.resolve(null);
    setFetchingAll(dataRef.current.rows.length);
    let loaded: DbTableData | null = null;
    return enqueue(async () => {
      try {
        while (seq === fetchSeqRef.current && dataRef.current?.hasMore) {
          if (!await appendRows(seq, FETCH_ALL_CHUNK)) break;
          if (seq === fetchSeqRef.current) setFetchingAll(dataRef.current?.rows.length ?? 0);
        }
        if (seq === fetchSeqRef.current && dataRef.current && !dataRef.current.hasMore) loaded = dataRef.current;
      } catch (e) {
        if (seq === fetchSeqRef.current) toast.error("Fetch all stopped", { description: (e as Error).message });
      } finally {
        if (seq === fetchSeqRef.current) setFetchingAll(null);
      }
    }).then(() => loaded);
  }, [enqueue, appendRows]);

  /** Count every row, without the background count's short time limit: the label was clicked. */
  const countExactly = useCallback(() => {
    const data = dataRef.current;
    const request = viewRequest(0, GRID_PAGE_SIZE);
    if (!data?.countKey || !request) return;
    requestCount({ ...request, exact: true }, data.countKey);
  }, [viewRequest, requestCount]);

  /** Replace the filters and show the first rows they match; answers the error when they could not be read. */
  const applyFilters = useCallback((filters: FilterRequest) => {
    filtersRef.current = filters;
    return readFirst();
  }, [readFirst]);

  /**
   * Show a table's first rows; answers the error when they could not be read. With `filtersFor`
   * the table opens on filters kept from before: they are read in the table's columns before
   * anything else is fetched, so the first rows shown are already filtered.
   */
  const selectTable = useCallback(async (
    name: string, tableSchema = "", filtersFor?: (cols: DbColumnInfo[]) => FilterRequest,
  ): Promise<Error | null> => {
    viewRef.current = { table: name, schema: tableSchema };
    setSelectedTable(name);
    setSelectedSchema(tableSchema);
    filtersRef.current = NO_FILTER_REQUEST;
    sortRef.current = [];
    setSortState([]);
    const cached = readCache(cacheDb, name, tableSchema);
    if (filtersFor) {
      // The columns say how each filter reads. If they cannot be read, the rows' own fetch says why.
      const cols = cached?.cols ?? await api.get<DbColumnInfo[]>(at(schemaPath(name, tableSchema))).catch(() => null);
      const request = cols ? filtersFor(cols) : NO_FILTER_REQUEST;
      if (cols && (request.filters.length > 0 || request.anyColumn.length > 0)) {
        // The cached rows are the table unfiltered, which is not what this tab shows.
        setSchema(cols);
        schemaForRef.current = JSON.stringify([name, tableSchema]);
        filtersRef.current = request;
        return readFirst({ table: name, tableSchema });
      }
    }
    // Show cached rows instantly, then read them again.
    if (cached) {
      showData(cached.data);
      setSchema(cached.cols);
      setLoading(false);
    }
    return readFirst({ table: name, tableSchema, structure: true });
  }, [at, cacheDb, readFirst, showData]);

  // Installed from the notice, from Settings or from another notice: run what needed it again.
  useDbDriverInstalled((driverId) => {
    if (driverMissing?.id !== driverId) return;
    const retry = retryRef.current;
    retryRef.current = null;
    retry?.();
  });

  /**
   * Save changes to the selected table — every edit, new row and deleted row, in one transaction —
   * through DBGate's Save changes dialog, then read again as many rows as are loaded. Rejects when
   * nothing was saved, which the dialog has said why, so the grid keeps its changes.
   */
  const saveChanges = useCallback(async (changes: GridChanges, place: DbTabPlace | null) => {
    const view = viewRef.current;
    if (!view || !target) return;
    await requestGridSave({ target, place, table: view.table, schema: view.schema, changes });
    void readFirst({ keepLoaded: true, recount: true });
  }, [target, readFirst]);

  /** Sort by these columns, in order, from the first row; empty is the table's own order. */
  const setSort = useCallback((next: GridSort[]) => {
    sortRef.current = next;
    setSortState(next);
    return readFirst({ sort: next });
  }, [readFirst]);

  /**
   * Read the rows again from the first, with their filters and sort, and count them again.
   * `keepPlace` reads as many as are loaded and leaves the view where it is: the form view's
   * Refresh, which DBGate keeps on the row it shows.
   */
  const reload = useCallback((opts: { structure?: boolean; keepPlace?: boolean } = {}) => (
    readFirst({ structure: opts.structure, recount: true, ...(opts.keepPlace ? { keepLoaded: true } : {}) })
  ), [readFirst]);

  /** An auto refresh: the loaded rows read again with nothing shown meanwhile; answers why it failed. */
  const refreshQuietly = useCallback(() => readFirst({ silent: true, keepLoaded: true }), [readFirst]);

  const rowCountLabel = useMemo(() => rowCountView(tableData, rowCount), [tableData, rowCount]);

  return {
    selectedTable, selectedSchema, selectTable, tableData, schema,
    loading, loadingMore, fetchingAll, error, driverMissing,
    rowCount: rowCountLabel, countExactly, viewKey,
    sort, setSort,
    loadMore, fetchAll, startExport, startCellDownload,
    saveChanges, reload, refreshQuietly, applyFilters,
  };
}
