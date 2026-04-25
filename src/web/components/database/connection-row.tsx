import { ChevronRight, ChevronDown, RefreshCw, Pencil, Trash2, Lock, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Connection, CachedTable } from "./use-connections";
import { SchemaTableTree, type ColumnInfo } from "./schema-table-tree";

interface ConnectionRowProps {
  conn: Connection;
  isExpanded: boolean;
  isRefreshing: boolean;
  tables: CachedTable[];
  schemas: Map<string, CachedTable[]>;
  isSingleSchema: boolean;
  filter: string;
  expandedTables: Set<string>;
  loadingColumns: Set<string>;
  columnCache?: Map<string, ColumnInfo[]>;
  columnErrors?: Set<string>;
  refreshError?: string;
  hasGroup: boolean;
  onToggle: (id: number, autoRefresh: boolean) => void;
  onRefresh: (id: number) => void;
  onEdit: (conn: Connection) => void;
  onDelete: (id: number) => void;
  onOpenTable: (conn: Connection, tableName: string, schemaName: string) => void;
  onToggleTable: (connId: number, tableName: string, schemaName: string) => void;
  onFilterChange: (connId: number, value: string) => void;
}

export function ConnectionRow({
  conn, isExpanded, isRefreshing, tables, schemas, isSingleSchema,
  filter, expandedTables, loadingColumns, columnCache, columnErrors,
  refreshError, hasGroup,
  onToggle, onRefresh, onEdit, onDelete, onOpenTable, onToggleTable, onFilterChange,
}: ConnectionRowProps) {
  const handleToggle = () => onToggle(conn.id, !isExpanded && tables.length === 0);

  return (
    <div>
      <div className={cn("group flex items-center gap-1 py-1 hover:bg-surface-elevated transition-colors", hasGroup ? "pl-3 pr-2" : "px-2")}>
        <button onClick={handleToggle} className="shrink-0 text-text-subtle hover:text-foreground transition-colors">
          {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <span className="shrink-0 size-2 rounded-full border border-border" style={{ backgroundColor: conn.color ?? "transparent" }} />
        <button className="flex-1 text-left text-xs truncate hover:text-primary transition-colors" onClick={handleToggle}>
          {conn.name}
        </button>
        <span className="shrink-0 text-[9px] text-text-subtle uppercase px-1 rounded bg-surface-elevated">
          {conn.type === "postgres" ? "PG" : "DB"}
        </span>
        {conn.readonly === 1 && <span title="Readonly"><Lock className="shrink-0 size-2.5 text-text-subtle" /></span>}
        <div className="flex can-hover:hidden can-hover:group-hover:flex items-center gap-0.5 shrink-0">
          <button onClick={() => onRefresh(conn.id)} disabled={isRefreshing} className="p-0.5 text-text-subtle hover:text-foreground transition-colors" title="Refresh tables">
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

      {isExpanded && (
        <div className="ml-[11px] border-l border-dashed border-border pl-1">
          {isRefreshing && tables.length === 0 && <p className="text-[10px] text-text-subtle px-2 py-1">Loading…</p>}
          {!isRefreshing && tables.length === 0 && (
            refreshError
              ? <p className="text-[10px] text-red-500 px-2 py-1 break-all">{refreshError}</p>
              : <p className="text-[10px] text-text-subtle px-2 py-1">No tables cached</p>
          )}
          {tables.length > 0 && (
            <>
              {tables.length > 5 && (
                <div className="flex items-center gap-1 px-2 py-0.5">
                  <Search className="size-2.5 text-text-subtle shrink-0" />
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => onFilterChange(conn.id, e.target.value)}
                    placeholder="Filter tables…"
                    className="w-full text-[10px] bg-transparent border-none outline-none text-foreground placeholder:text-text-subtle"
                  />
                </div>
              )}
              <SchemaTableTree
                connId={conn.id}
                schemas={schemas}
                isSingleSchema={isSingleSchema}
                filter={filter}
                expandedTables={expandedTables}
                loadingColumns={loadingColumns}
                columnCache={columnCache}
                columnErrors={columnErrors}
                onToggleTable={onToggleTable}
                onOpenTable={(tableName, schemaName) => onOpenTable(conn, tableName, schemaName)}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
