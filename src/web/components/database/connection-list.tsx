import { useState, useMemo } from "react";
import { ChevronRight, ChevronDown, Database, RefreshCw, Pencil, Trash2, Lock, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Connection, CachedTable } from "./use-connections";

interface ConnectionListProps {
  connections: Connection[];
  cachedTables: Map<number, CachedTable[]>;
  onOpenTable: (conn: Connection, tableName: string, schemaName: string) => void;
  onRefreshTables: (id: number) => Promise<void>;
  onEdit: (conn: Connection) => void;
  onDelete: (id: number) => void;
}

interface GroupMap {
  [group: string]: Connection[];
}

export function ConnectionList({
  connections, cachedTables,
  onOpenTable, onRefreshTables, onEdit, onDelete,
}: ConnectionListProps) {
  const [expandedConns, setExpandedConns] = useState<Set<number>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["__ungrouped__"]));
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());
  const [tableFilter, setTableFilter] = useState<Map<number, string>>(new Map());

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
            {/* Group header (only shown when there are multiple groups or named group) */}
            {hasGroup && (
              <button
                onClick={() => toggleGroup(group)}
                className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-text-subtle uppercase tracking-wider hover:text-text-secondary transition-colors"
              >
                {isGroupExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {label}
              </button>
            )}

            {/* Connections — indented with tree guide line when inside a group */}
            {isGroupExpanded && (
              <div className={hasGroup ? "ml-[11px] border-l border-dashed border-border" : ""}>
                {groupConns.map((conn) => {
              const isExpanded = expandedConns.has(conn.id);
              const tables = cachedTables.get(conn.id) ?? [];
              const isRefreshing = refreshingIds.has(conn.id);

              return (
                <div key={conn.id}>
                  {/* Connection row */}
                  <div className={cn("group flex items-center gap-1 py-1 hover:bg-surface-elevated transition-colors", hasGroup ? "pl-3 pr-2" : "px-2")}>
                    {/* Expand arrow */}
                    <button
                      onClick={() => {
                        toggleConn(conn.id);
                        if (!expandedConns.has(conn.id) && tables.length === 0) {
                          handleRefresh(conn.id);
                        }
                      }}
                      className="shrink-0 text-text-subtle hover:text-foreground transition-colors"
                    >
                      {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    </button>

                    {/* Color dot */}
                    <span
                      className="shrink-0 size-2 rounded-full border border-border"
                      style={{ backgroundColor: conn.color ?? "transparent" }}
                    />

                    {/* Name — click toggles expand */}
                    <button
                      className="flex-1 text-left text-xs truncate hover:text-primary transition-colors"
                      onClick={() => {
                        toggleConn(conn.id);
                        if (!expandedConns.has(conn.id) && tables.length === 0) {
                          handleRefresh(conn.id);
                        }
                      }}
                    >
                      {conn.name}
                    </button>

                    {/* DB type badge */}
                    <span className="shrink-0 text-[9px] text-text-subtle uppercase px-1 rounded bg-surface-elevated">
                      {conn.type === "postgres" ? "PG" : "DB"}
                    </span>

                    {/* Readonly lock */}
                    {conn.readonly === 1 && (
                      <span title="Readonly">
                        <Lock className="shrink-0 size-2.5 text-text-subtle" aria-label="Readonly" />
                      </span>
                    )}

                    {/* Actions (hover) */}
                    <div className="flex can-hover:hidden can-hover:group-hover:flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => handleRefresh(conn.id)}
                        disabled={isRefreshing}
                        className="p-0.5 text-text-subtle hover:text-foreground transition-colors"
                        title="Refresh tables"
                      >
                        <RefreshCw className={cn("size-3", isRefreshing && "animate-spin")} />
                      </button>
                      <button
                        onClick={() => onEdit(conn)}
                        className="p-0.5 text-text-subtle hover:text-foreground transition-colors"
                        title="Edit"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        onClick={() => onDelete(conn.id)}
                        className="p-0.5 text-text-subtle hover:text-red-500 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </div>

                  {/* Table list (expanded) with tree guide line */}
                  {isExpanded && (
                    <div className="ml-[11px] border-l border-dashed border-border pl-3">
                      {isRefreshing && tables.length === 0 && (
                        <p className="text-[10px] text-text-subtle px-2 py-1">Loading…</p>
                      )}
                      {!isRefreshing && tables.length === 0 && (
                        <p className="text-[10px] text-text-subtle px-2 py-1">No tables cached</p>
                      )}
                      {tables.length > 0 && (
                        <TableListWithFilter
                          connId={conn.id}
                          tables={tables}
                          filter={tableFilter.get(conn.id) ?? ""}
                          onFilterChange={(v) => setTableFilter((prev) => new Map(prev).set(conn.id, v))}
                          onOpenTable={(tableName, schemaName) => onOpenTable(conn, tableName, schemaName)}
                        />
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

/* ---------- Table list with filter ---------- */
const MAX_TABLE_HEIGHT = 200; // px

function TableListWithFilter({ connId, tables, filter, onFilterChange, onOpenTable }: {
  connId: number;
  tables: CachedTable[];
  filter: string;
  onFilterChange: (v: string) => void;
  onOpenTable: (tableName: string, schemaName: string) => void;
}) {
  const filtered = useMemo(() => {
    if (!filter) return tables;
    const q = filter.toLowerCase();
    return tables.filter((t) => t.tableName.toLowerCase().includes(q));
  }, [tables, filter]);

  return (
    <div>
      {/* Filter input — show when many tables */}
      {tables.length > 5 && (
        <div className="flex items-center gap-1 px-1 py-0.5">
          <Search className="size-2.5 text-text-subtle shrink-0" />
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter tables…"
            className="w-full text-[10px] bg-transparent border-none outline-none text-foreground placeholder:text-text-subtle"
          />
        </div>
      )}
      {/* Scrollable table list */}
      <div className="overflow-y-auto" style={{ maxHeight: MAX_TABLE_HEIGHT }}>
        {filtered.map((t) => (
          <button
            key={`${connId}-${t.schemaName}.${t.tableName}`}
            onClick={() => onOpenTable(t.tableName, t.schemaName)}
            className="w-full flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-text-secondary hover:text-foreground hover:bg-surface-elevated transition-colors text-left truncate"
          >
            <Database className="size-2.5 shrink-0 text-text-subtle" />
            <span className="truncate">{t.tableName}</span>
          </button>
        ))}
        {filter && filtered.length === 0 && (
          <p className="text-[10px] text-text-subtle px-2 py-1">No match</p>
        )}
      </div>
    </div>
  );
}
