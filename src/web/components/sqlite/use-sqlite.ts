import { useState, useEffect, useCallback } from "react";
import { api, projectUrl } from "@/lib/api-client";

export interface TableInfo { name: string; rowCount: number }
export interface ColumnInfo { cid: number; name: string; type: string; notnull: boolean; pk: boolean; dflt_value: string | null }
export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; rowsAffected: number; changeType: "select" | "modify" }
interface TableData { columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number }

export function useSqlite(projectName: string, dbPath: string, connectionId?: number) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [schema, setSchema] = useState<ColumnInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  // When connectionId present, use unified API; otherwise use project-scoped API
  const unifiedBase = connectionId ? `/api/db/connections/${connectionId}` : null;
  const base = unifiedBase ?? `${projectUrl(projectName)}/sqlite`;
  const qs = unifiedBase ? "" : `path=${encodeURIComponent(dbPath)}`;

  // Fetch tables on mount — use cache when connectionId (sidebar handles live sync)
  const fetchTables = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qsPart = unifiedBase ? "?cached=1" : qs ? `?${qs}` : "";
      const data = await api.get<TableInfo[]>(`${base}/tables${qsPart}`);
      setTables(data);
      if (!unifiedBase && data.length > 0 && !selectedTable) setSelectedTable(data[0]!.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base, qs, unifiedBase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchTables(); }, [fetchTables]);

  // Fetch table data when selection or page changes
  const fetchTableData = useCallback(async () => {
    if (!selectedTable) return;
    setLoading(true);
    try {
      const qsPrefix = qs ? `${qs}&` : "";
      const [data, cols] = await Promise.all([
        api.get<TableData>(`${base}/data?${qsPrefix}table=${encodeURIComponent(selectedTable)}&page=${page}&limit=100`),
        api.get<ColumnInfo[]>(`${base}/schema?${qsPrefix}table=${encodeURIComponent(selectedTable)}`),
      ]);
      setTableData(data);
      setSchema(cols);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base, qs, selectedTable, page]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchTableData(); }, [fetchTableData]);

  const selectTable = useCallback((name: string) => {
    setSelectedTable(name);
    setPage(1);
    setQueryResult(null);
  }, []);

  const executeQuery = useCallback(async (sql: string) => {
    setQueryLoading(true);
    setQueryError(null);
    try {
      const body = unifiedBase ? { sql } : { path: dbPath, sql };
      const result = await api.post<QueryResult>(`${base}/query`, body);
      setQueryResult(result);
      if (result.changeType === "modify") fetchTableData();
    } catch (e) {
      setQueryError((e as Error).message);
    } finally {
      setQueryLoading(false);
    }
  }, [base, unifiedBase, dbPath, fetchTableData]);

  const updateCell = useCallback(async (rowid: number, column: string, value: unknown) => {
    if (!selectedTable) return;
    try {
      if (unifiedBase) {
        await api.put(`${base}/cell`, { table: selectedTable, pkColumn: "rowid", pkValue: rowid, column, value });
      } else {
        await api.put(`${base}/cell`, { path: dbPath, table: selectedTable, rowid, column, value });
      }
      fetchTableData();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, unifiedBase, dbPath, selectedTable, fetchTableData]);

  return {
    tables, selectedTable, selectTable, tableData, schema,
    loading, error, page, setPage,
    queryResult, queryError, queryLoading, executeQuery,
    updateCell, refreshTables: fetchTables, refreshData: fetchTableData,
  };
}
