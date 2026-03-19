import { Table, RefreshCw } from "lucide-react";
import type { TableInfo } from "./use-sqlite";

interface Props {
  tables: TableInfo[];
  selectedTable: string | null;
  onSelect: (name: string) => void;
  onRefresh: () => void;
}

export function SqliteTableList({ tables, selectedTable, onSelect, onRefresh }: Props) {
  return (
    <div className="w-48 shrink-0 flex flex-col bg-background overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tables</span>
        <button
          type="button"
          onClick={onRefresh}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh tables"
        >
          <RefreshCw className="size-3" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tables.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => onSelect(t.name)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
              selectedTable === t.name
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            }`}
          >
            <Table className="size-3 shrink-0" />
            <span className="truncate flex-1">{t.name}</span>
            <span className="text-[10px] opacity-60">{t.rowCount}</span>
          </button>
        ))}
        {tables.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">No tables found</p>
        )}
      </div>
    </div>
  );
}
