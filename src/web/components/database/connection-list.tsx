import { useState, useMemo } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { Connection, CachedTable } from "./use-connections";
import type { ColumnInfo } from "./schema-table-tree";
import { ConnectionRow } from "./connection-row";

interface ConnectionListProps {
  connections: Connection[];
  cachedTables: Map<number, CachedTable[]>;
  refreshErrors?: Map<number, string>;
  onOpenTable: (conn: Connection, tableName: string, schemaName: string) => void;
  onRefreshTables: (id: number) => Promise<void>;
  onEdit: (conn: Connection) => void;
  onDelete: (id: number) => void;
  onFetchColumns?: (connId: number, table: string, schema?: string) => Promise<ColumnInfo[]>;
  columnCache?: Map<string, ColumnInfo[]>;
}

export function ConnectionList({
  connections, cachedTables, refreshErrors,
  onOpenTable, onRefreshTables, onEdit, onDelete,
  onFetchColumns, columnCache,
}: ConnectionListProps) {
  const [expandedConns, setExpandedConns] = useState<Set<number>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["__ungrouped__"]));
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());
  const [tableFilter, setTableFilter] = useState<Map<number, string>>(new Map());
  const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());
  const [columnErrors, setColumnErrors] = useState<Set<string>>(new Set());

  const toggleConn = (id: number, autoRefresh: boolean) => {
    setExpandedConns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (autoRefresh) handleRefresh(id);
  };

  const toggleGroup = (group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  };

  const toggleTable = async (connId: number, tableName: string, schemaName: string) => {
    const key = `${connId}:${schemaName}.${tableName}`;
    if (expandedTables.has(key)) {
      setExpandedTables((prev) => { const n = new Set(prev); n.delete(key); return n; });
      return;
    }
    setExpandedTables((prev) => new Set(prev).add(key));
    if (onFetchColumns && !columnCache?.has(key)) {
      setLoadingColumns((prev) => new Set(prev).add(key));
      setColumnErrors((prev) => { const n = new Set(prev); n.delete(key); return n; });
      try {
        await onFetchColumns(connId, tableName, schemaName);
      } catch {
        setColumnErrors((prev) => new Set(prev).add(key));
      }
      setLoadingColumns((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const handleRefresh = async (id: number) => {
    setRefreshingIds((p) => new Set(p).add(id));
    try { await onRefreshTables(id); } finally {
      setRefreshingIds((p) => { const n = new Set(p); n.delete(id); return n; });
    }
  };

  const handleFilterChange = (connId: number, value: string) => {
    setTableFilter((prev) => new Map(prev).set(connId, value));
  };

  // L3 fix: memoize group computation
  const { groups, groupKeys } = useMemo(() => {
    const g: Record<string, Connection[]> = {};
    for (const conn of connections) {
      const key = conn.group_name ?? "__ungrouped__";
      (g[key] ??= []).push(conn);
    }
    const keys = Object.keys(g).sort((a, b) => {
      if (a === "__ungrouped__") return 1;
      if (b === "__ungrouped__") return -1;
      return a.localeCompare(b);
    });
    return { groups: g, groupKeys: keys };
  }, [connections]);

  const schemasPerConn = useMemo(() => {
    const result = new Map<number, Map<string, CachedTable[]>>();
    for (const conn of connections) {
      const tables = cachedTables.get(conn.id) ?? [];
      const map = new Map<string, CachedTable[]>();
      for (const t of tables) {
        const key = t.schemaName;
        (map.get(key) ?? map.set(key, []).get(key)!).push(t);
      }
      result.set(conn.id, map);
    }
    return result;
  }, [connections, cachedTables]);

  if (connections.length === 0) {
    return (
      <p className="px-4 py-6 text-xs text-text-subtle text-center">
        No connections yet.<br />Click + to add one.
      </p>
    );
  }

  return (
    <div className="py-1">
      {groupKeys.map((group) => {
        const isGroupExpanded = expandedGroups.has(group);
        const label = group === "__ungrouped__" ? "Ungrouped" : group;
        const groupConns = groups[group]!;
        const hasGroup = groupKeys.length > 1 || group !== "__ungrouped__";

        return (
          <div key={group}>
            {hasGroup && (
              <button
                onClick={() => toggleGroup(group)}
                className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-text-subtle uppercase tracking-wider hover:text-text-secondary transition-colors"
              >
                {isGroupExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {label}
              </button>
            )}

            {isGroupExpanded && (
              <div className={hasGroup ? "ml-[11px] border-l border-dashed border-border" : ""}>
                {groupConns.map((conn) => (
                  <ConnectionRow
                    key={conn.id}
                    conn={conn}
                    isExpanded={expandedConns.has(conn.id)}
                    isRefreshing={refreshingIds.has(conn.id)}
                    tables={cachedTables.get(conn.id) ?? []}
                    schemas={schemasPerConn.get(conn.id) ?? new Map()}
                    isSingleSchema={(schemasPerConn.get(conn.id)?.size ?? 0) <= 1}
                    filter={tableFilter.get(conn.id) ?? ""}
                    expandedTables={expandedTables}
                    loadingColumns={loadingColumns}
                    columnCache={columnCache}
                    columnErrors={columnErrors}
                    refreshError={refreshErrors?.get(conn.id)}
                    hasGroup={hasGroup}
                    onToggle={toggleConn}
                    onRefresh={handleRefresh}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onOpenTable={onOpenTable}
                    onToggleTable={toggleTable}
                    onFilterChange={handleFilterChange}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
