import { useState } from "react";
import { ChevronRight, ChevronDown, Database, RefreshCw, Pencil, Trash2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Connection, CachedTable } from "./use-connections";

interface ConnectionListProps {
  connections: Connection[];
  cachedTables: Map<number, CachedTable[]>;
  onOpenConnection: (conn: Connection) => void;
  onOpenTable: (conn: Connection, tableName: string, schemaName: string) => void;
  onRefreshTables: (id: number) => Promise<void>;
  onEdit: (conn: Connection) => void;
  onDelete: (id: number) => void;
}

interface GroupMap {
  [group: string]: Connection[];
}

const MAX_VISIBLE_TABLES = 10;

export function ConnectionList({
  connections, cachedTables,
  onOpenConnection, onOpenTable, onRefreshTables, onEdit, onDelete,
}: ConnectionListProps) {
  const [expandedConns, setExpandedConns] = useState<Set<number>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["__ungrouped__"]));
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());
  const [showAllTables, setShowAllTables] = useState<Set<number>>(new Set());

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

        return (
          <div key={group}>
            {/* Group header (only shown when there are multiple groups or named group) */}
            {(groupKeys.length > 1 || group !== "__ungrouped__") && (
              <button
                onClick={() => toggleGroup(group)}
                className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-text-subtle uppercase tracking-wider hover:text-text-secondary transition-colors"
              >
                {isGroupExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {label}
              </button>
            )}

            {isGroupExpanded && groupConns.map((conn) => {
              const isExpanded = expandedConns.has(conn.id);
              const tables = cachedTables.get(conn.id) ?? [];
              const isRefreshing = refreshingIds.has(conn.id);
              const showAll = showAllTables.has(conn.id);
              const visibleTables = showAll ? tables : tables.slice(0, MAX_VISIBLE_TABLES);

              return (
                <div key={conn.id}>
                  {/* Connection row */}
                  <div className="group flex items-center gap-1 px-2 py-1 hover:bg-surface-elevated transition-colors">
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

                    {/* Name — click opens connection viewer */}
                    <button
                      className="flex-1 text-left text-xs truncate hover:text-primary transition-colors"
                      onClick={() => onOpenConnection(conn)}
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
                    <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
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

                  {/* Table list (expanded) */}
                  {isExpanded && (
                    <div className="pl-6">
                      {isRefreshing && tables.length === 0 && (
                        <p className="text-[10px] text-text-subtle px-2 py-1">Loading…</p>
                      )}
                      {!isRefreshing && tables.length === 0 && (
                        <p className="text-[10px] text-text-subtle px-2 py-1">No tables cached</p>
                      )}
                      {visibleTables.map((t) => (
                        <button
                          key={`${t.schemaName}.${t.tableName}`}
                          onClick={() => onOpenTable(conn, t.tableName, t.schemaName)}
                          className="w-full flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-text-secondary hover:text-foreground hover:bg-surface-elevated transition-colors text-left truncate"
                        >
                          <Database className="size-2.5 shrink-0 text-text-subtle" />
                          <span className="truncate">{t.tableName}</span>
                        </button>
                      ))}
                      {tables.length > MAX_VISIBLE_TABLES && !showAll && (
                        <button
                          onClick={() => setShowAllTables((p) => new Set(p).add(conn.id))}
                          className="w-full text-left px-2 py-0.5 text-[10px] text-text-subtle hover:text-text-secondary transition-colors"
                        >
                          +{tables.length - MAX_VISIBLE_TABLES} more…
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
