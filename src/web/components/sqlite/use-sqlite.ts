import { useState, useEffect, useCallback } from "react";
import { api, projectUrl } from "@/lib/api-client";

export interface TableInfo { name: string; rowCount: number }
export interface ColumnInfo { cid: number; name: string; type: string; notnull: boolean; pk: boolean; dflt_value: string | null }
export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; rowsAffected: number; changeType: "select" | "modify" }
interface TableData { columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number }

export function useSqlite(projectName: string, dbPath: string) {
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

  const base = `${projectUrl(projectName)}/sqlite`;
  const qs = `path=${encodeURIComponent(dbPath)}`;

  // Fetch tables on mount
  const fetchTables = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<TableInfo[]>(`${base}/tables?${qs}`);
      setTables(data);
      if (data.length > 0 && !selectedTable) setSelectedTable(data[0].name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base, qs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchTables(); }, [fetchTables]);

  // Fetch table data when selection or page changes
  const fetchTableData = useCallback(async () => {
    if (!selectedTable) return;
    setLoading(true);
    try {
      const [data, cols] = await Promise.all([
        api.get<TableData>(`${base}/data?${qs}&table=${encodeURIComponent(selectedTable)}&page=${page}&limit=100`),
        api.get<ColumnInfo[]>(`${base}/schema?${qs}&table=${encodeURIComponent(selectedTable)}`),
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
      const result = await api.post<QueryResult>(`${base}/query`, { path: dbPath, sql });
      setQueryResult(result);
      if (result.changeType === "modify") fetchTableData(); // Refresh table after modification
    } catch (e) {
      setQueryError((e as Error).message);
    } finally {
      setQueryLoading(false);
    }
  }, [base, dbPath, fetchTableData]);

  const updateCell = useCallback(async (rowid: number, column: string, value: unknown) => {
    if (!selectedTable) return;
    try {
      await api.put(`${base}/cell`, { path: dbPath, table: selectedTable, rowid, column, value });
      fetchTableData(); // Refresh
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, dbPath, selectedTable, fetchTableData]);

  return {
    tables, selectedTable, selectTable, tableData, schema,
    loading, error, page, setPage,
    queryResult, queryError, queryLoading, executeQuery,
    updateCell, refreshTables: fetchTables, refreshData: fetchTableData,
  };
}
