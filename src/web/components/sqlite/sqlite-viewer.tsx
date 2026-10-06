/**
 * A database file opened from a file tree, a file explorer window or an editor: its tables and
 * views in a list, and the one picked in the same view a saved connection's table gets. The file
 * is not a saved connection — every request names it (`?path=&project=`) and the server checks
 * it every time. Structure ↗, SQL ↗ and New query open tabs of their own on the same file.
 */
import { useMemo } from "react";
import { ChevronDown, Database, Eye, Layers, RefreshCw, SquareTerminal, Table } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useTabStore } from "@/stores/tab-store";
import type { DbObject, DbObjectList } from "../../../shared/db-structure";
import { useDbTab } from "../database/use-db-tab";
import { useDbRead } from "../database/use-db-read";
import { KINDS_WITH_COLUMNS, formatRowEstimate } from "../database/explorer/explorer-model";
import { openQueryTab } from "../database/explorer/open-db-tabs";
import { DbTabState, toolButtonClass } from "../database/db-tab-parts";
import { TableView } from "../database/table/table-tab";

interface SqliteViewerProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

const KIND_ICONS = { table: Table, view: Eye, matview: Layers } as const;

export function SqliteViewer({ metadata, tabId }: SqliteViewerProps) {
  const filePath = typeof metadata?.filePath === "string" ? metadata.filePath : "";
  const projectName = typeof metadata?.projectName === "string" && metadata.projectName ? metadata.projectName : undefined;
  // The file as a database tab's target; this tab's own metadata keeps the shape file trees open it with.
  const fileMeta = useMemo(
    () => (filePath ? { dbFile: { path: filePath, ...(projectName ? { projectName } : {}) } } : undefined),
    [filePath, projectName],
  );
  const tab = useDbTab(fileMeta, undefined);
  const list = useDbRead<DbObjectList>(tab.target, "/objects", tabId);
  const relations = useMemo(() => list.data?.objects.filter((o) => KINDS_WITH_COLUMNS.has(o.kind)) ?? [], [list.data]);

  const picked = typeof metadata?.tableName === "string" ? metadata.tableName : null;
  const selected = relations.find((o) => o.name === picked) ?? null;
  const pick = (name: string) => {
    if (tabId) useTabStore.getState().updateTab(tabId, { metadata: { ...metadata, tableName: name } });
  };
  const newQuery = () => { if (tab.place) openQueryTab(tab.place, ""); };

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary">
        <Database className="size-5" /> No database file selected.
      </div>
    );
  }
  if (!list.data) return <DbTabState loading={list.loading || (!list.error && !list.driver)} error={list.error} driver={list.driver} />;

  return (
    <div className="flex h-full w-full overflow-hidden max-md:flex-col">
      {/* Desktop: the list beside the table. */}
      <aside aria-label="Tables and views" className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-border bg-background max-md:hidden">
        <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border pr-1 pl-3">
          <span className="flex-1 truncate text-xs font-medium tracking-wider text-text-subtle uppercase">Tables</span>
          <button type="button" onClick={newQuery} disabled={!tab.place} title="New query on this file" aria-label="New query" className={cn(toolButtonClass, "px-1.5")}>
            <SquareTerminal className="size-4" />
          </button>
          <button type="button" onClick={() => list.reload()} title="Refresh the list" aria-label="Refresh the list" className={cn(toolButtonClass, "px-1.5")}>
            <RefreshCw className={cn("size-4", list.loading && "animate-spin")} />
          </button>
        </div>
        <div role="listbox" aria-label="Tables and views" className="min-h-0 flex-1 overflow-y-auto py-1">
          {relations.map((o) => <RelationItem key={o.name} o={o} selected={o.name === selected?.name} onPick={pick} />)}
          {relations.length === 0 && <p className="px-3 py-4 text-center text-xs text-text-subtle">No tables found</p>}
        </div>
      </aside>

      {/* Phone: the list is a picker above the table. */}
      <div className="hidden shrink-0 items-center gap-1 border-b border-border bg-panel-2 px-2 py-1 max-md:flex">
        <span className="relative flex min-w-0 flex-1">
          <select
            aria-label="Table" value={selected?.name ?? ""} onChange={(e) => pick(e.target.value)}
            className="h-11 w-full min-w-0 appearance-none rounded-[5px] border border-border bg-input pr-[26px] pl-2 text-sm text-foreground outline-none focus:border-primary"
          >
            {!selected && <option value="">{relations.length ? "Pick a table…" : "No tables found"}</option>}
            {relations.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-text-subtle" />
        </span>
        <button type="button" onClick={newQuery} disabled={!tab.place} aria-label="New query" className={toolButtonClass}>
          <SquareTerminal className="size-5" />
        </button>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {selected ? (
          <TableView key={selected.name} tab={tab} table={selected.name} schemaName="" objectKind={selected.kind} header={false} shownIn={tabId} />
        ) : (
          <DbTabState empty={relations.length ? "Pick a table to see its rows." : "This database has no tables yet."} />
        )}
      </div>
    </div>
  );
}

function RelationItem({ o, selected, onPick }: { o: DbObject; selected: boolean; onPick: (name: string) => void }) {
  const Icon = KIND_ICONS[o.kind as keyof typeof KIND_ICONS] ?? Table;
  return (
    <button
      type="button" role="option" aria-selected={selected} onClick={() => onPick(o.name)}
      className={cn(
        "flex h-7 w-full items-center gap-2 px-3 text-left text-xs",
        selected ? "bg-accent-wash text-foreground" : "text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text-primary",
      )}
    >
      <Icon className={cn("size-4 shrink-0", selected ? "text-primary" : "text-text-subtle")} />
      <span className="min-w-0 flex-1 truncate">{o.name}</span>
      {o.rowEstimate !== undefined && <span className="shrink-0 font-mono text-[10px] text-text-subtle">{formatRowEstimate(o.rowEstimate)}</span>}
    </button>
  );
}
