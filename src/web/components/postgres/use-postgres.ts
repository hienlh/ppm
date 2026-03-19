import { useState, useCallback } from "react";
import { api } from "@/lib/api-client";

export interface PgTableInfo { name: string; schema: string; rowCount: number }
export interface PgColumnInfo { name: string; type: string; nullable: boolean; pk: boolean; defaultValue: string | null }
export interface PgQueryResult { columns: string[]; rows: Record<string, unknown>[]; rowsAffected: number; changeType: "select" | "modify" }
interface PgTableData { columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number }

const BASE = "/api/postgres";

export function usePostgres() {
  const [connectionString, setConnectionString] = useState("");
  const [connected, setConnected] = useState(false);
  const [tables, setTables] = useState<PgTableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [selectedSchema, setSelectedSchema] = useState("public");
  const [tableData, setTableData] = useState<PgTableData | null>(null);
  const [schema, setSchema] = useState<PgColumnInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [queryResult, setQueryResult] = useState<PgQueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  const connect = useCallback(async (connStr: string) => {
    setLoading(true);
    setError(null);
    try {
      const test = await api.post<{ ok: boolean; error?: string }>(`${BASE}/test`, { connectionString: connStr });
      if (!test.ok) { setError(test.error ?? "Connection failed"); return; }
      setConnectionString(connStr);
      setConnected(true);
      // Fetch tables
      const data = await api.post<PgTableInfo[]>(`${BASE}/tables`, { connectionString: connStr });
      setTables(data);
      if (data.length > 0) {
        setSelectedTable(data[0]!.name);
        setSelectedSchema(data[0]!.schema);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTables = useCallback(async () => {
    if (!connectionString) return;
    setLoading(true);
    try {
      const data = await api.post<PgTableInfo[]>(`${BASE}/tables`, { connectionString });
      setTables(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connectionString]);

  const fetchTableData = useCallback(async (table?: string, tableSchema?: string, p?: number) => {
    const t = table ?? selectedTable;
    const s = tableSchema ?? selectedSchema;
    if (!connectionString || !t) return;
    setLoading(true);
    try {
      const [data, cols] = await Promise.all([
        api.post<PgTableData>(`${BASE}/data`, { connectionString, table: t, schema: s, page: p ?? page, limit: 100 }),
        api.post<PgColumnInfo[]>(`${BASE}/schema`, { connectionString, table: t, schema: s }),
      ]);
      setTableData(data);
      setSchema(cols);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connectionString, selectedTable, selectedSchema, page]);

  const selectTable = useCallback((name: string, tableSchema = "public") => {
    setSelectedTable(name);
    setSelectedSchema(tableSchema);
    setPage(1);
    setQueryResult(null);
    fetchTableData(name, tableSchema, 1);
  }, [fetchTableData]);

  const changePage = useCallback((p: number) => {
    setPage(p);
    fetchTableData(undefined, undefined, p);
  }, [fetchTableData]);

  const executeQuery = useCallback(async (sql: string) => {
    if (!connectionString) return;
    setQueryLoading(true);
    setQueryError(null);
    try {
      const result = await api.post<PgQueryResult>(`${BASE}/query`, { connectionString, sql });
      setQueryResult(result);
      if (result.changeType === "modify") fetchTableData();
    } catch (e) {
      setQueryError((e as Error).message);
    } finally {
      setQueryLoading(false);
    }
  }, [connectionString, fetchTableData]);

  const updateCell = useCallback(async (pkColumn: string, pkValue: unknown, column: string, value: unknown) => {
    if (!connectionString || !selectedTable) return;
    try {
      await api.post(`${BASE}/cell`, {
        connectionString, table: selectedTable, schema: selectedSchema,
        pkColumn, pkValue, column, value,
      });
      fetchTableData();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [connectionString, selectedTable, selectedSchema, fetchTableData]);

  return {
    connectionString, connected, connect,
    tables, selectedTable, selectTable, tableData, schema,
    loading, error, page, setPage: changePage,
    queryResult, queryError, queryLoading, executeQuery,
    updateCell, refreshTables: fetchTables, refreshData: fetchTableData,
  };
}
