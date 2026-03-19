import { useState, useCallback } from "react";
import { api } from "@/lib/api-client";

export interface DbTableInfo { name: string; schema: string; rowCount: number }
export interface DbColumnInfo { name: string; type: string; nullable: boolean; pk: boolean; defaultValue: string | null }
export interface DbQueryResult { columns: string[]; rows: Record<string, unknown>[]; rowsAffected: number; changeType: "select" | "modify" }
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPageState] = useState(1);
  const [queryResult, setQueryResult] = useState<DbQueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  // Fetch table data + schema for current selection
  const fetchTableData = useCallback(async (table?: string, tableSchema?: string, p?: number) => {
    const t = table ?? selectedTable;
    const s = tableSchema ?? selectedSchema;
    if (!t) return;
    setLoading(true);
    try {
      const [data, cols] = await Promise.all([
        api.get<DbTableData>(`${base}/data?table=${encodeURIComponent(t)}&schema=${s}&page=${p ?? page}&limit=100`),
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
  }, [base, connectionId, selectedTable, selectedSchema, page]);

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
      if (result.changeType === "modify") fetchTableData();
    } catch (e) {
      setQueryError((e as Error).message);
    } finally {
      setQueryLoading(false);
    }
  }, [base, fetchTableData]);

  const updateCell = useCallback(async (pkColumn: string, pkValue: unknown, column: string, value: unknown) => {
    if (!selectedTable) return;
    try {
      await api.put(`${base}/cell`, { table: selectedTable, schema: selectedSchema, pkColumn, pkValue, column, value });
      fetchTableData();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, selectedTable, selectedSchema, fetchTableData]);

  return {
    selectedTable, selectTable, tableData, schema,
    loading, error, page, setPage: changePage,
    queryResult, queryError, queryLoading, executeQuery,
    updateCell, refreshData: fetchTableData,
  };
}
