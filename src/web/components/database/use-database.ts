import { useState, useCallback } from "react";
import { api } from "@/lib/api-client";

export interface DbTableInfo { name: string; schema: string; rowCount: number }
export interface DbColumnInfo { name: string; type: string; nullable: boolean; pk: boolean; defaultValue: string | null }
export interface DbQueryResult { columns: string[]; rows: Record<string, unknown>[]; rowsAffected: number; changeType: "select" | "modify"; executionTimeMs?: number }
interface DbTableData { columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number }

/** SessionStorage cache key for table data */
function cacheKey(connectionId: number, table: string, schema: string, page: number) {
  return `ppm-db-${connectionId}-${schema}.${table}-p${page}`;
}

function readCache(connectionId: number, table: string, schema: string, page: number): { data: DbTableData; cols: DbColumnInfo[] } | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(connectionId, table, schema, page));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(connectionId: number, table: string, schema: string, page: number, data: DbTableData, cols: DbColumnInfo[]) {
  try { sessionStorage.setItem(cacheKey(connectionId, table, schema, page), JSON.stringify({ data, cols })); } catch { /* quota */ }
}

/**
 * Generic database hook for unified API (/api/db/connections/:id/...).
 * Works for any DB type (postgres, sqlite, mysql, etc.) via adapter pattern.
 * No auto-fetch on mount — viewer calls selectTable() to start loading.
 */
export function useDatabase(connectionId: number) {
  const base = `/api/db/connections/${connectionId}`;
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [selectedSchema, setSelectedSchema] = useState("public");
  const [tableData, setTableData] = useState<DbTableData | null>(null);
  const [schema, setSchema] = useState<DbColumnInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPageState] = useState(1);
  const [queryResult, setQueryResult] = useState<DbQueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  // Sort state
  const [orderBy, setOrderBy] = useState<string | null>(null);
  const [orderDir, setOrderDir] = useState<"ASC" | "DESC">("ASC");

  // Fetch table data + schema for current selection
  const fetchTableData = useCallback(async (table?: string, tableSchema?: string, p?: number, sortCol?: string | null, sortDir?: "ASC" | "DESC") => {
    const t = table ?? selectedTable;
    const s = tableSchema ?? selectedSchema;
    if (!t) return;
    setLoading(true);
    const ob = sortCol !== undefined ? sortCol : orderBy;
    const od = sortDir ?? orderDir;
    try {
      const orderParams = ob ? `&orderBy=${encodeURIComponent(ob)}&orderDir=${od}` : "";
      const [data, cols] = await Promise.all([
        api.get<DbTableData>(`${base}/data?table=${encodeURIComponent(t)}&schema=${s}&page=${p ?? page}&limit=100${orderParams}`),
        api.get<DbColumnInfo[]>(`${base}/schema?table=${encodeURIComponent(t)}&schema=${s}`),
      ]);
      setTableData(data);
      setSchema(cols);
      writeCache(connectionId, t, s, p ?? page, data, cols);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base, connectionId, selectedTable, selectedSchema, page, orderBy, orderDir]);

  const selectTable = useCallback((name: string, tableSchema = "public") => {
    setSelectedTable(name);
    setSelectedSchema(tableSchema);
    setPageState(1);
    setQueryResult(null);
    // Show cached data instantly, then refresh in background
    const cached = readCache(connectionId, name, tableSchema, 1);
    if (cached) {
      setTableData(cached.data);
      setSchema(cached.cols);
      setLoading(false);
      // Still fetch fresh data in background
      fetchTableData(name, tableSchema, 1);
    } else {
      fetchTableData(name, tableSchema, 1);
    }
  }, [connectionId, fetchTableData]);

  const changePage = useCallback((p: number) => {
    setPageState(p);
    fetchTableData(undefined, undefined, p);
  }, [fetchTableData]);

  const executeQuery = useCallback(async (sqlText: string) => {
    setQueryLoading(true);
    setQueryError(null);
    try {
      const result = await api.post<DbQueryResult>(`${base}/query`, { sql: sqlText });
      setQueryResult(result);
      if (result.changeType === "modify") fetchTableData(selectedTable ?? undefined, selectedSchema);
    } catch (e) {
      setQueryError((e as Error).message);
    } finally {
      setQueryLoading(false);
    }
  }, [base, selectedTable, selectedSchema, fetchTableData]);

  const updateCell = useCallback(async (pkColumn: string, pkValue: unknown, column: string, value: unknown) => {
    if (!selectedTable) return;
    const t = selectedTable;
    const s = selectedSchema;
    try {
      await api.put(`${base}/cell`, { table: t, schema: s, pkColumn, pkValue, column, value });
      // Re-fetch with explicit args to avoid stale closure
      fetchTableData(t, s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, selectedTable, selectedSchema, fetchTableData]);

  const deleteRow = useCallback(async (pkColumn: string, pkValue: unknown) => {
    if (!selectedTable) return;
    const t = selectedTable;
    const s = selectedSchema;
    try {
      await api.del(`${base}/row`, { table: t, schema: s, pkColumn, pkValue });
      fetchTableData(t, s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, selectedTable, selectedSchema, fetchTableData]);

  /** Toggle sort: none → ASC → DESC → none */
  const toggleSort = useCallback((column: string) => {
    let newCol: string | null;
    let newDir: "ASC" | "DESC" = "ASC";
    if (orderBy !== column) {
      newCol = column; newDir = "ASC";
    } else if (orderDir === "ASC") {
      newCol = column; newDir = "DESC";
    } else {
      newCol = null; newDir = "ASC";
    }
    setOrderBy(newCol);
    setOrderDir(newDir);
    setPageState(1);
    fetchTableData(undefined, undefined, 1, newCol, newDir);
  }, [orderBy, orderDir, fetchTableData]);

  /** Bulk delete rows */
  const bulkDelete = useCallback(async (pkColumn: string, pkValues: unknown[]) => {
    if (!selectedTable) return;
    const t = selectedTable;
    const s = selectedSchema;
    try {
      await api.post(`${base}/rows/delete`, { table: t, schema: s, pkColumn, pkValues });
      fetchTableData(t, s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, selectedTable, selectedSchema, fetchTableData]);

  /** Insert a new row */
  const insertRow = useCallback(async (values: Record<string, unknown>) => {
    if (!selectedTable) return;
    const t = selectedTable;
    const s = selectedSchema;
    try {
      await api.post(`${base}/row`, { table: t, schema: s, values });
      fetchTableData(t, s);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [base, selectedTable, selectedSchema, fetchTableData]);

  /** Execute SQL but put results into tableData (for column filters) */
  const queryAsTable = useCallback(async (sqlText: string) => {
    setLoading(true);
    try {
      const result = await api.post<DbQueryResult>(`${base}/query`, { sql: sqlText });
      if (result.changeType === "select") {
        setTableData({ columns: result.columns, rows: result.rows, total: result.rows.length, page: 1, limit: result.rows.length });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base]);

  return {
    selectedTable, selectedSchema, selectTable, tableData, schema,
    loading, error, page, setPage: changePage,
    orderBy, orderDir, toggleSort,
    queryResult, queryError, queryLoading, executeQuery,
    updateCell, deleteRow, bulkDelete, insertRow,
    refreshData: fetchTableData, queryAsTable,
  };
}
