import { useState, useEffect, useCallback } from "react";

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

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json() as { ok: boolean; data?: T; error?: string };
  if (!json.ok) throw new Error(json.error ?? "Request failed");
  return json.data as T;
}

export function useConnections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [cachedTables, setCachedTables] = useState<Map<number, CachedTable[]>>(new Map());

  const fetchConnections = useCallback(async () => {
    try {
      const data = await apiFetch<Connection[]>("/api/db/connections");
      setConnections(data);
    } catch {
      // ignore — server may not be ready
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConnections(); }, [fetchConnections]);

  const createConnection = useCallback(async (data: CreateConnectionData): Promise<Connection> => {
    const conn = await apiFetch<Connection>("/api/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    setConnections((prev) => [...prev, conn]);
    return conn;
  }, []);

  const updateConnection = useCallback(async (id: number, data: UpdateConnectionData): Promise<void> => {
    const updated = await apiFetch<Connection>(`/api/db/connections/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    setConnections((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const deleteConnection = useCallback(async (id: number): Promise<void> => {
    await apiFetch(`/api/db/connections/${id}`, { method: "DELETE" });
    setConnections((prev) => prev.filter((c) => c.id !== id));
    setCachedTables((prev) => { const m = new Map(prev); m.delete(id); return m; });
  }, []);

  const testConnection = useCallback(async (id: number): Promise<{ ok: boolean; error?: string }> => {
    return apiFetch(`/api/db/connections/${id}/test`, { method: "POST" });
  }, []);

  const refreshTables = useCallback(async (id: number): Promise<void> => {
    const tables = await apiFetch<CachedTable[]>(`/api/db/connections/${id}/tables`);
    setCachedTables((prev) => new Map(prev).set(id, tables));
  }, []);

  return { connections, loading, cachedTables, createConnection, updateConnection, deleteConnection, testConnection, refreshTables };
}
