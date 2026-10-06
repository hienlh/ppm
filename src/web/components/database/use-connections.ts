import { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/api-client";
import type { DbType } from "../../../shared/db-types";
import type { PasswordMode } from "../../../shared/db-connection-config";
import { DB_CONNECTIONS_CHANGED, type DbConnectionsChangedDetail } from "./db-sidebar-reveal";

export interface Connection {
  id: number;
  type: DbType;
  name: string;
  group_name: string | null;
  color: string | null;
  readonly: number;
  /** 1 = available to the AI chat, 0 = `ppm db` run from a chat neither lists nor opens it. */
  ai_access?: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** How the connection gets its password; the ask modes open through Database Log In. */
  password_mode?: PasswordMode;
  /** The server holds a login for a connection that asks for one. */
  logged_in?: boolean;
  allowed_databases?: string[];
  allowed_databases_regex?: string | null;
  /** The database the URL names, null when it names none (and for SQLite). */
  default_database?: string | null;
  /** Shown as one database rather than a server with a list of them. */
  single_database?: boolean;
  /** Where it connects: host[:port], a socket, a SQLite path. Never with a password. */
  server?: string | null;
  user?: string | null;
}

export interface CachedTable {
  connectionId: number;
  tableName: string;
  schemaName: string;
  rowCount: number;
  cachedAt: string;
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
  const [cachedTables, setCachedTables] = useState<Map<number, CachedTable[]>>(new Map());

  const fetchConnections = useCallback(async () => {
    try {
      const data = await api.get<Connection[]>("/api/db/connections");
      setConnections(data);
    } catch {
      // ignore — server may not be ready
    }
  }, []);

  useEffect(() => { fetchConnections(); }, [fetchConnections]);

  const updateConnection = useCallback(async (id: number, data: UpdateConnectionData): Promise<void> => {
    const updated = await api.put<Connection>(`/api/db/connections/${id}`, data);
    setConnections((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const refreshTables = useCallback(async (id: number): Promise<void> => {
    const raw = await api.get<{ name: string; schema: string; rowCount: number }[]>(`/api/db/connections/${id}/tables`);
    const tables: CachedTable[] = raw.map((t) => ({
      connectionId: id,
      tableName: t.name,
      schemaName: t.schema,
      rowCount: t.rowCount,
      cachedAt: new Date().toISOString(),
    }));
    setCachedTables((prev) => new Map(prev).set(id, tables));
  }, []);

  // The connection tab and Database Log In change connections from outside this list.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const { connectionId, refreshTables: reread } = (e as CustomEvent<DbConnectionsChangedDetail>).detail ?? {};
      void fetchConnections();
      if (reread && connectionId !== undefined) refreshTables(connectionId).catch(() => { /* the older list stays */ });
    };
    window.addEventListener(DB_CONNECTIONS_CHANGED, onChanged);
    return () => window.removeEventListener(DB_CONNECTIONS_CHANGED, onChanged);
  }, [fetchConnections, refreshTables]);

  return { connections, cachedTables, updateConnection, refreshTables };
}
