import { useState, useMemo } from "react";
import { ChevronRight, ChevronDown, Database, RefreshCw, Pencil, Trash2, Lock, Search, Key, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Connection, CachedTable } from "./use-connections";

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  fk: { table: string; column: string } | null;
}

interface ConnectionListProps {
  connections: Connection[];
  cachedTables: Map<number, CachedTable[]>;
  onOpenTable: (conn: Connection, tableName: string, schemaName: string) => void;
  onRefreshTables: (id: number) => Promise<void>;
  onEdit: (conn: Connection) => void;
  onDelete: (id: number) => void;
  onFetchColumns?: (connId: number, table: string, schema?: string) => Promise<ColumnInfo[]>;
  columnCache?: Map<string, ColumnInfo[]>;
}

interface GroupMap {
  [group: string]: Connection[];
}

export function ConnectionList({
  connections, cachedTables,
  onOpenTable, onRefreshTables, onEdit, onDelete,
  onFetchColumns, columnCache,
}: ConnectionListProps) {
  const [expandedConns, setExpandedConns] = useState<Set<number>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["__ungrouped__"]));
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());
  const [tableFilter, setTableFilter] = useState<Map<number, string>>(new Map());
  const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());

  const toggleConn = (id: number) => {
    setExpandedConns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
    // Lazy load columns if not cached
    if (onFetchColumns && !columnCache?.has(key)) {
      setLoadingColumns((prev) => new Set(prev).add(key));
      try { await onFetchColumns(connId, tableName, schemaName); } catch { /* ignore */ }
      setLoadingColumns((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const handleRefresh = async (id: number) => {
    setRefreshingIds((p) => new Set(p).add(id));
    try { await onRefreshTables(id); } finally {
      setRefreshingIds((p) => { const n = new Set(p); n.delete(id); return n; });
    }
  };

  // Group connections
  const groups: GroupMap = {};
  for (const conn of connections) {
    const key = conn.group_name ?? "__ungrouped__";
    (groups[key] ??= []).push(conn);
  }
  const groupKeys = Object.keys(groups).sort((a, b) => {
    if (a === "__ungrouped__") return 1;
    if (b === "__ungrouped__") return -1;
    return a.localeCompare(b);
  });

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
                {groupConns.map((conn) => {
                  const isExpanded = expandedConns.has(conn.id);
                  const tables = cachedTables.get(conn.id) ?? [];
                  const isRefreshing = refreshingIds.has(conn.id);

                  // Group tables by schema for postgres
                  const schemas = useMemo(() => {
                    const map = new Map<string, CachedTable[]>();
                    for (const t of tables) {
                      const key = t.schemaName;
                      (map.get(key) ?? map.set(key, []).get(key)!).push(t);
                    }
                    return map;
                  }, [tables]);

                  const isSingleSchema = schemas.size <= 1;
                  const filter = tableFilter.get(conn.id) ?? "";

                  return (
                    <div key={conn.id}>
                      {/* Connection row */}
                      <div className={cn("group flex items-center gap-1 py-1 hover:bg-surface-elevated transition-colors", hasGroup ? "pl-3 pr-2" : "px-2")}>
                        <button
                          onClick={() => {
                            toggleConn(conn.id);
                            if (!expandedConns.has(conn.id) && tables.length === 0) handleRefresh(conn.id);
                          }}
                          className="shrink-0 text-text-subtle hover:text-foreground transition-colors"
                        >
                          {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        </button>
                        <span className="shrink-0 size-2 rounded-full border border-border" style={{ backgroundColor: conn.color ?? "transparent" }} />
                        <button
                          className="flex-1 text-left text-xs truncate hover:text-primary transition-colors"
                          onClick={() => {
                            toggleConn(conn.id);
                            if (!expandedConns.has(conn.id) && tables.length === 0) handleRefresh(conn.id);
                          }}
                        >
                          {conn.name}
                        </button>
                        <span className="shrink-0 text-[9px] text-text-subtle uppercase px-1 rounded bg-surface-elevated">
                          {conn.type === "postgres" ? "PG" : "DB"}
                        </span>
                        {conn.readonly === 1 && <span title="Readonly"><Lock className="shrink-0 size-2.5 text-text-subtle" /></span>}
                        <div className="flex can-hover:hidden can-hover:group-hover:flex items-center gap-0.5 shrink-0">
                          <button onClick={() => handleRefresh(conn.id)} disabled={isRefreshing} className="p-0.5 text-text-subtle hover:text-foreground transition-colors" title="Refresh tables">
                            <RefreshCw className={cn("size-3", isRefreshing && "animate-spin")} />
                          </button>
                          <button onClick={() => onEdit(conn)} className="p-0.5 text-text-subtle hover:text-foreground transition-colors" title="Edit">
                            <Pencil className="size-3" />
                          </button>
                          <button onClick={() => onDelete(conn.id)} className="p-0.5 text-text-subtle hover:text-red-500 transition-colors" title="Delete">
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      </div>

                      {/* Expanded tree: schemas > tables > columns */}
                      {isExpanded && (
                        <div className="ml-[11px] border-l border-dashed border-border pl-1">
                          {isRefreshing && tables.length === 0 && <p className="text-[10px] text-text-subtle px-2 py-1">Loading…</p>}
                          {!isRefreshing && tables.length === 0 && <p className="text-[10px] text-text-subtle px-2 py-1">No tables cached</p>}
                          {tables.length > 0 && (
                            <>
                              {tables.length > 5 && (
                                <div className="flex items-center gap-1 px-2 py-0.5">
                                  <Search className="size-2.5 text-text-subtle shrink-0" />
                                  <input
                                    type="text"
                                    value={filter}
                                    onChange={(e) => setTableFilter((prev) => new Map(prev).set(conn.id, e.target.value))}
                                    placeholder="Filter tables…"
                                    className="w-full text-[10px] bg-transparent border-none outline-none text-foreground placeholder:text-text-subtle"
                                  />
                                </div>
                              )}
                              <SchemaTableTree
                                connId={conn.id}
                                connType={conn.type}
                                schemas={schemas}
                                isSingleSchema={isSingleSchema}
                                filter={filter}
                                expandedTables={expandedTables}
                                loadingColumns={loadingColumns}
                                columnCache={columnCache}
                                onToggleTable={toggleTable}
                                onOpenTable={(tableName, schemaName) => onOpenTable(conn, tableName, schemaName)}
                              />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Schema > Table > Column tree ---------- */

function SchemaTableTree({ connId, connType, schemas, isSingleSchema, filter, expandedTables, loadingColumns, columnCache, onToggleTable, onOpenTable }: {
  connId: number;
  connType: "sqlite" | "postgres";
  schemas: Map<string, CachedTable[]>;
  isSingleSchema: boolean;
  filter: string;
  expandedTables: Set<string>;
  loadingColumns: Set<string>;
  columnCache?: Map<string, ColumnInfo[]>;
  onToggleTable: (connId: number, tableName: string, schemaName: string) => void;
  onOpenTable: (tableName: string, schemaName: string) => void;
}) {
  const filterLower = filter.toLowerCase();

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 300 }}>
      {Array.from(schemas.entries()).map(([schemaName, tables]) => {
        const filteredTables = filterLower
          ? tables.filter((t) => t.tableName.toLowerCase().includes(filterLower))
          : tables;
        if (filteredTables.length === 0) return null;

        return (
          <div key={schemaName}>
            {/* Schema label (only for postgres with multiple schemas) */}
            {!isSingleSchema && (
              <p className="px-2 py-0.5 text-[9px] font-semibold text-text-subtle uppercase tracking-wider">{schemaName}</p>
            )}
            {filteredTables.map((t) => {
              const tableKey = `${connId}:${t.schemaName}.${t.tableName}`;
              const isTableExpanded = expandedTables.has(tableKey);
              const isLoadingCols = loadingColumns.has(tableKey);
              const columns = columnCache?.get(tableKey);

              return (
                <div key={tableKey}>
                  {/* Table row */}
                  <div className="flex items-center gap-1 pl-2 pr-2 py-0.5 hover:bg-surface-elevated transition-colors group/table">
                    <button
                      onClick={() => onToggleTable(connId, t.tableName, t.schemaName)}
                      className="shrink-0 text-text-subtle hover:text-foreground transition-colors"
                    >
                      {isTableExpanded ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
                    </button>
                    <Database className="size-2.5 shrink-0 text-text-subtle" />
                    <button
                      onClick={() => onOpenTable(t.tableName, t.schemaName)}
                      className="flex-1 text-left text-[11px] text-text-secondary hover:text-foreground transition-colors truncate"
                    >
                      {t.tableName}
                    </button>
                    <span className="text-[9px] text-text-subtle">{t.rowCount}</span>
                  </div>

                  {/* Columns (lazy loaded) */}
                  {isTableExpanded && (
                    <div className="ml-[18px] border-l border-dotted border-border pl-2">
                      {isLoadingCols && <p className="text-[9px] text-text-subtle px-1 py-0.5">Loading…</p>}
                      {columns && columns.map((col) => (
                        <div key={col.name} className="flex items-center gap-1 px-1 py-px text-[10px] text-text-subtle" title={col.fk ? `FK → ${col.fk.table}.${col.fk.column}` : undefined}>
                          {col.pk && <Key className="size-2.5 text-amber-500 shrink-0" />}
                          {col.fk && <Link2 className="size-2.5 text-blue-400 shrink-0" />}
                          {!col.pk && !col.fk && <span className="size-2.5 shrink-0" />}
                          <span className="truncate">{col.name}{col.nullable ? "?" : ""}</span>
                          <span className="ml-auto text-[9px] text-text-subtle/60 shrink-0">{col.type}</span>
                        </div>
                      ))}
                      {!isLoadingCols && !columns && <p className="text-[9px] text-text-subtle px-1 py-0.5">No columns</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {filter && Array.from(schemas.values()).every((t) => !t.some((x) => x.tableName.toLowerCase().includes(filterLower))) && (
        <p className="text-[10px] text-text-subtle px-2 py-1">No match</p>
      )}
    </div>
  );
}
