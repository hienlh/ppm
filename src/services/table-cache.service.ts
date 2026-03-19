import {
  getCachedTables, upsertTableCache, deleteTableCache, searchTableCache,
  getConnectionById, type TableCacheRow,
} from "./db.service.ts";
import { getAdapter } from "./database/adapter-registry.ts";
import type { DbConnectionConfig } from "../types/database.ts";

export interface CachedTable {
  connectionId: number;
  tableName: string;
  schemaName: string;
  rowCount: number;
  cachedAt: string;
}

export interface TableSearchResult {
  connectionId: number;
  connectionName: string;
  connectionType: string;
  connectionColor: string | null;
  tableName: string;
  schemaName: string;
}

function rowToTable(r: TableCacheRow): CachedTable {
  return {
    connectionId: r.connection_id,
    tableName: r.table_name,
    schemaName: r.schema_name,
    rowCount: r.row_count,
    cachedAt: r.cached_at,
  };
}

/** Get cached tables for a connection (no live fetch) */
export function getTablesFromCache(connectionId: number): CachedTable[] {
  return getCachedTables(connectionId).map(rowToTable);
}

/** Fetch live tables via adapter, update cache, return result */
export async function syncTables(connectionId: number): Promise<CachedTable[]> {
  const conn = getConnectionById(connectionId);
  if (!conn) throw new Error(`Connection not found: ${connectionId}`);

  const config = JSON.parse(conn.connection_config) as DbConnectionConfig;
  const adapter = getAdapter(conn.type);
  const tables = await adapter.getTables(config);

  // Delete stale cache entries, then upsert fresh ones
  deleteTableCache(connectionId);
  for (const t of tables) {
    upsertTableCache(connectionId, t.name, t.schema || "main", t.rowCount);
  }

  return tables.map((t) => ({
    connectionId,
    tableName: t.name,
    schemaName: t.schema || "main",
    rowCount: t.rowCount,
    cachedAt: new Date().toISOString(),
  }));
}

/** Search cached tables across all connections (for command palette) */
export function searchTables(query: string): TableSearchResult[] {
  if (!query || query.length < 2) return [];
  return searchTableCache(query).map((r) => ({
    connectionId: r.connection_id,
    connectionName: r.connection_name,
    connectionType: r.connection_type,
    connectionColor: r.connection_color,
    tableName: r.table_name,
    schemaName: r.schema_name,
  }));
}
