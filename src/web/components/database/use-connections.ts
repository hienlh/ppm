import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../../lib/api-client";

export interface Connection {
  id: number;
  type: "sqlite" | "postgres";
  name: string;
  group_name: string | null;
  color: string | null;
  readonly: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CachedTable {
  connectionId: number;
  tableName: string;
  schemaName: string;
  rowCount: number;
  cachedAt: string;
}

export interface CreateConnectionData {
  type: "sqlite" | "postgres";
  name: string;
  connectionConfig: { type: string; path?: string; connectionString?: string };
  groupName?: string;
  color?: string;
}

export interface UpdateConnectionData {
  name?: string;
  connectionConfig?: { type: string; path?: string; connectionString?: string };
  groupName?: string | null;
  color?: string | null;
  readonly?: number;
}

export function useConnections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [cachedTables, setCachedTables] = useState<Map<number, CachedTable[]>>(new Map());
  const [refreshErrors, setRefreshErrors] = useState<Map<number, string>>(new Map());

  const fetchConnections = useCallback(async () => {
    try {
      const data = await api.get<Connection[]>("/api/db/connections");
      setConnections(data);
    } catch {
      // ignore — server may not be ready
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConnections(); }, [fetchConnections]);

  const createConnection = useCallback(async (data: CreateConnectionData): Promise<Connection> => {
    const conn = await api.post<Connection>("/api/db/connections", data);
    setConnections((prev) => [...prev, conn]);
    return conn;
  }, []);

  const updateConnection = useCallback(async (id: number, data: UpdateConnectionData): Promise<void> => {
    const updated = await api.put<Connection>(`/api/db/connections/${id}`, data);
    setConnections((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const deleteConnection = useCallback(async (id: number): Promise<void> => {
    await api.del(`/api/db/connections/${id}`);
    setConnections((prev) => prev.filter((c) => c.id !== id));
    setCachedTables((prev) => { const m = new Map(prev); m.delete(id); return m; });
  }, []);

  const testConnection = useCallback(async (id: number): Promise<{ ok: boolean; error?: string }> => {
    return api.post(`/api/db/connections/${id}/test`);
  }, []);

  const testRawConnection = useCallback(async (
    type: "sqlite" | "postgres",
    connectionConfig: { type: string; path?: string; connectionString?: string },
  ): Promise<{ ok: boolean; error?: string }> => {
    return api.post("/api/db/test", { type, connectionConfig });
  }, []);

  const refreshTables = useCallback(async (id: number): Promise<void> => {
    setRefreshErrors((prev) => { const m = new Map(prev); m.delete(id); return m; });
    try {
      const raw = await api.get<{ name: string; schema: string; rowCount: number }[]>(`/api/db/connections/${id}/tables`);
      const tables: CachedTable[] = raw.map((t) => ({
        connectionId: id,
        tableName: t.name,
        schemaName: t.schema,
        rowCount: t.rowCount,
        cachedAt: new Date().toISOString(),
      }));
      setCachedTables((prev) => new Map(prev).set(id, tables));
    } catch (e) {
      const msg = (e as Error).message || "Connection failed";
      setRefreshErrors((prev) => new Map(prev).set(id, msg));
      throw e; // re-throw so callers know it failed
    }
  }, []);

  /** Fetch column metadata for a table (lazy loaded for schema tree) */
  type ColumnInfo = { name: string; type: string; nullable: boolean; pk: boolean; fk: { table: string; column: string } | null };
  const [columnCache, setColumnCache] = useState<Map<string, ColumnInfo[]>>(new Map());
  const columnCacheRef = useRef(columnCache);
  columnCacheRef.current = columnCache;
  const fetchColumns = useCallback(async (connId: number, table: string, schema?: string): Promise<ColumnInfo[]> => {
    const cacheKey = `${connId}:${schema ?? "main"}.${table}`;
    const cached = columnCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const cols = await api.get<ColumnInfo[]>(
      `/api/db/connections/${connId}/schema?table=${encodeURIComponent(table)}${schema ? `&schema=${encodeURIComponent(schema)}` : ""}`,
    );
    setColumnCache((prev) => new Map(prev).set(cacheKey, cols));
    return cols;
  }, []);

  const exportConnections = useCallback(async () => {
    return api.get<{ version: number; exported_at: string; connections: unknown[] }>("/api/db/connections/export");
  }, []);

  const importConnections = useCallback(async (data: { connections: unknown[] }) => {
    const result = await api.post<{ imported: number; skipped: number; errors: string[]; connections: Connection[] }>(
      "/api/db/connections/import", data,
    );
    await fetchConnections();
    // Auto-refresh table cache for newly imported connections (fire-and-forget)
    const imported = result.connections ?? [];
    if (imported.length > 0) {
      Promise.all(imported.map((c) => refreshTables(c.id).catch(() => {})));
    }
    return result;
  }, [fetchConnections, refreshTables]);

  return { connections, loading, cachedTables, refreshErrors, columnCache, createConnection, updateConnection, deleteConnection, testConnection, testRawConnection, refreshTables, fetchColumns, exportConnections, importConnections };
}
