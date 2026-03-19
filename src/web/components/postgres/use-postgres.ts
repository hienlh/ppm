import { useState, useCallback, useEffect } from "react";
import { api } from "@/lib/api-client";

export interface PgTableInfo { name: string; schema: string; rowCount: number }
export interface PgColumnInfo { name: string; type: string; nullable: boolean; pk: boolean; defaultValue: string | null }
export interface PgQueryResult { columns: string[]; rows: Record<string, unknown>[]; rowsAffected: number; changeType: "select" | "modify" }
interface PgTableData { columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number }

const BASE = "/api/postgres";

export function usePostgres(connectionId?: number) {
  const [connectionString, setConnectionString] = useState("");
  const [connected, setConnected] = useState(false);
  // Unified API base when connectionId is provided
  const unifiedBase = connectionId ? `/api/db/connections/${connectionId}` : null;
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
    if (unifiedBase) {
      setLoading(true);
      try {
        const data = await api.get<PgTableInfo[]>(`${unifiedBase}/tables`);
        setTables(data);
        if (data.length > 0 && !selectedTable) {
          setSelectedTable(data[0]!.name);
          setSelectedSchema(data[0]!.schema ?? "public");
        }
      } catch (e) { setError((e as Error).message); }
      finally { setLoading(false); }
      return;
    }
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
  }, [unifiedBase, connectionString, selectedTable]);

  // Auto-connect via unified API when connectionId is provided
  useEffect(() => {
    if (unifiedBase) {
      setConnected(true);
      fetchTables();
    }
  }, [unifiedBase]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchTableData = useCallback(async (table?: string, tableSchema?: string, p?: number) => {
    const t = table ?? selectedTable;
    const s = tableSchema ?? selectedSchema;
    if (!t) return;
    setLoading(true);
    try {
      if (unifiedBase) {
        const [data, cols] = await Promise.all([
          api.get<PgTableData>(`${unifiedBase}/data?table=${encodeURIComponent(t)}&schema=${s}&page=${p ?? page}&limit=100`),
          api.get<PgColumnInfo[]>(`${unifiedBase}/schema?table=${encodeURIComponent(t)}&schema=${s}`),
        ]);
        setTableData(data);
        setSchema(cols);
      } else {
        if (!connectionString) return;
        const [data, cols] = await Promise.all([
          api.post<PgTableData>(`${BASE}/data`, { connectionString, table: t, schema: s, page: p ?? page, limit: 100 }),
          api.post<PgColumnInfo[]>(`${BASE}/schema`, { connectionString, table: t, schema: s }),
        ]);
        setTableData(data);
        setSchema(cols);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [unifiedBase, connectionString, selectedTable, selectedSchema, page]);

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
    if (!unifiedBase && !connectionString) return;
    setQueryLoading(true);
    setQueryError(null);
    try {
      const result = unifiedBase
        ? await api.post<PgQueryResult>(`${unifiedBase}/query`, { sql })
        : await api.post<PgQueryResult>(`${BASE}/query`, { connectionString, sql });
      setQueryResult(result);
      if (result.changeType === "modify") fetchTableData();
    } catch (e) {
      setQueryError((e as Error).message);
    } finally {
      setQueryLoading(false);
    }
  }, [unifiedBase, connectionString, fetchTableData]);

  const updateCell = useCallback(async (pkColumn: string, pkValue: unknown, column: string, value: unknown) => {
    if (!selectedTable) return;
    try {
      if (unifiedBase) {
        await api.put(`${unifiedBase}/cell`, { table: selectedTable, schema: selectedSchema, pkColumn, pkValue, column, value });
      } else {
        if (!connectionString) return;
        await api.post(`${BASE}/cell`, { connectionString, table: selectedTable, schema: selectedSchema, pkColumn, pkValue, column, value });
      }
      fetchTableData();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [unifiedBase, connectionString, selectedTable, selectedSchema, fetchTableData]);

  return {
    connectionString, connected, connect,
    tables, selectedTable, selectTable, tableData, schema,
    loading, error, page, setPage: changePage,
    queryResult, queryError, queryLoading, executeQuery,
    updateCell, refreshTables: fetchTables, refreshData: fetchTableData,
  };
}
