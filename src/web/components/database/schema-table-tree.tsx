import { ChevronRight, ChevronDown, Database, Key, Link2 } from "lucide-react";
import type { CachedTable } from "./use-connections";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  fk: { table: string; column: string } | null;
}

interface SchemaTableTreeProps {
  connId: number;
  schemas: Map<string, CachedTable[]>;
  isSingleSchema: boolean;
  filter: string;
  expandedTables: Set<string>;
  loadingColumns: Set<string>;
  columnCache?: Map<string, ColumnInfo[]>;
  columnErrors?: Set<string>;
  onToggleTable: (connId: number, tableName: string, schemaName: string) => void;
  onOpenTable: (tableName: string, schemaName: string) => void;
}

export function SchemaTableTree({
  connId, schemas, isSingleSchema, filter,
  expandedTables, loadingColumns, columnCache, columnErrors,
  onToggleTable, onOpenTable,
}: SchemaTableTreeProps) {
  const filterLower = filter.toLowerCase();

  return (
    <div className="overflow-y-auto max-h-[40vh]">
      {Array.from(schemas.entries()).map(([schemaName, tables]) => {
        const filteredTables = filterLower
          ? tables.filter((t) => t.tableName.toLowerCase().includes(filterLower))
          : tables;
        if (filteredTables.length === 0) return null;

        return (
          <div key={schemaName}>
            {!isSingleSchema && (
              <p className="px-2 py-0.5 text-[9px] font-semibold text-text-subtle uppercase tracking-wider">{schemaName}</p>
            )}
            {filteredTables.map((t) => {
              const tableKey = `${connId}:${t.schemaName}.${t.tableName}`;
              const isTableExpanded = expandedTables.has(tableKey);
              const isLoadingCols = loadingColumns.has(tableKey);
              const columns = columnCache?.get(tableKey);
              const hasError = columnErrors?.has(tableKey);

              return (
                <div key={tableKey}>
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

                  {isTableExpanded && (
                    <div className="ml-[18px] border-l border-dotted border-border pl-2">
                      {isLoadingCols && <p className="text-[9px] text-text-subtle px-1 py-0.5">Loading…</p>}
                      {hasError && <p className="text-[9px] text-red-500 px-1 py-0.5">Failed to load columns</p>}
                      {columns && columns.map((col) => (
                        <div key={col.name} className="flex items-center gap-1 px-1 py-px text-[10px] text-text-subtle" title={col.fk ? `FK → ${col.fk.table}.${col.fk.column}` : undefined}>
                          {col.pk && <Key className="size-2.5 text-amber-500 shrink-0" />}
                          {col.fk && <Link2 className="size-2.5 text-blue-400 shrink-0" />}
                          {!col.pk && !col.fk && <span className="size-2.5 shrink-0" />}
                          <span className="truncate">{col.name}{col.nullable ? "?" : ""}</span>
                          <span className="ml-auto text-[9px] text-text-subtle/60 shrink-0">{col.type}</span>
                        </div>
                      ))}
                      {!isLoadingCols && !hasError && !columns && <p className="text-[9px] text-text-subtle px-1 py-0.5">No columns</p>}
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
