/**
 * DBGate's CONNECTIONS widget: the saved connections, their folders, and a server's databases
 * under it once it is open. Bold is the current database — what the section below lists — and
 * the tinted row is the one picked here; ✓, a spinner and ! say how opening a connection went.
 *
 * One context menu serves the whole list, resolved from the row the gesture landed on, as the
 * file tree does it: right-click on a desktop, long-press into a bottom sheet on a phone.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { toast } from "sonner";
import {
  AlertCircle, CheckCircle, ChevronDown, ChevronRight, Database, Filter, Folder, FolderOpen, FolderPlus, Loader2, Lock, Plus,
  RefreshCw, SquareMinus, SquarePlus,
} from "@/lib/icons";
import { DbEngineIcon } from "@/lib/file-icons";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import { Button } from "@/components/ui/button";
import {
  connectConnection, createFolder, deleteConnection, deleteFolder, focusRow, loadConnections, pickDatabase, renameFolder,
  setConnectionQuery, setCurrentDatabase, setExplorerView, toggleConnectionExpanded, toggleFolder, useDbExplorer,
} from "../explorer/db-explorer-store";
import {
  CONNECTION_SEARCH_FIELDS, connectionShownBelow, connectionWhere, folderNames, singleDbRef, type ConnectionSearchField, type TreeConnection,
} from "../explorer/explorer-model";
import { RowMenuContent, ToolbarMenu, type MenuEntry } from "../explorer/explorer-menu";
import {
  EmptyState, Highlight, RowTail, SearchBox, SectionHeader, TreeRow, linkButtonClass, toolbarButtonClass,
} from "../explorer/tree-parts";
import { treeRowDomId, useTreeKeys } from "../explorer/use-tree-keys";
import { useRowMenu } from "../explorer/use-row-menu";
import { DriverMissingNotice } from "../driver-missing-notice";
import { openConnectionForm } from "../open-connection-form";
import { useDbSidebarReveal } from "../db-sidebar-reveal";
import { connectionTreeRows, searchFoundNothing, type ConnectionTreeRow } from "./connection-tree-model";
import { connectionMenu, databaseMenu, folderMenu, type ConnectionMenuActions } from "./connection-menus";
import { FolderNameInput } from "./folder-name-input";
import { DeleteConnectionDialog } from "./delete-connection-dialog";

/** How long a connection just saved from its tab stays lit. */
const FLASH_MS = 1400;

const KNOWN_FIELDS = new Set<string>(CONNECTION_SEARCH_FIELDS.map((f) => f.field));

const focusable = (r: ConnectionTreeRow) => r.kind === "folder" || r.kind === "connection" || r.kind === "database";
const depthOf = (r: ConnectionTreeRow) => ("depth" in r ? r.depth : 0);

function errorText(e: unknown): string {
  return (e as Error)?.message || "Something went wrong";
}

interface ConnectionsSectionProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Called once the section opened a tab: the phone's drawer closes so the tab can be seen. */
  onNavigate?: () => void;
  className?: string;
  style?: CSSProperties;
}

export function ConnectionsSection({ collapsed, onToggleCollapsed, onNavigate, className, style }: ConnectionsSectionProps) {
  const connections = useDbExplorer((s) => s.connections);
  const loaded = useDbExplorer((s) => s.loaded);
  const listError = useDbExplorer((s) => s.listError);
  const status = useDbExplorer((s) => s.status);
  const databases = useDbExplorer((s) => s.databases);
  const focused = useDbExplorer((s) => s.focused);
  const query = useDbExplorer((s) => s.connectionQuery);
  const prefs = useSettingsStore((s) => s.dbExplorer);
  const view = useSettingsStore((s) => s.dbExplorerView);
  const revealId = useDbSidebarReveal((s) => s.revealId);

  const fields = useMemo(
    () => view.connectionSearch.filter((f): f is ConnectionSearchField => KNOWN_FIELDS.has(f)),
    [view.connectionSearch],
  );
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TreeConnection | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();

  const rows = useMemo(() => connectionTreeRows({
    connections, status, databases, prefs, current: view.current, focused, query, fields, creatingFolder, renamingFolder,
  }), [connections, status, databases, prefs, view.current, focused, query, fields, creatingFolder, renamingFolder]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // A failure the object list below is showing — its Install button with it — is not repeated under the row.
  const shownBelow = view.objectsCollapsed ? null : connectionShownBelow(focused, view.current, (id) => connections.some((c) => c.id === id));

  // A connection just saved from its tab: scrolled to and lit, once the list holds it.
  const flashKey = revealId !== null && rows.some((r) => r.kind === "connection" && r.conn.id === revealId) ? `conn:${revealId}` : null;
  useEffect(() => {
    if (revealId === null || flashKey === null) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row-key="${flashKey}"]`)?.scrollIntoView?.({ block: "nearest" });
    const timer = setTimeout(() => useDbSidebarReveal.getState().clear(revealId), FLASH_MS);
    return () => clearTimeout(timer);
  }, [revealId, flashKey]);

  const navigated = useCallback(() => onNavigate?.(), [onNavigate]);
  const mobile = useIsMobile();

  const actions: ConnectionMenuActions = useMemo(() => ({
    navigated,
    editsStructure: !mobile,
    impExp: !mobile,
    edit: (conn) => { openConnectionForm(conn); navigated(); },
    askDelete: (conn) => setDeleting(conn),
    renameFolder: (name) => { setCreatingFolder(false); setRenamingFolder(name); },
    deleteFolder: (name) => { deleteFolder(name).catch((e) => toast.error(`Could not delete the folder: ${errorText(e)}`)); },
    failed: (what, e) => toast.error(`${what}: ${errorText(e)}`),
  }), [navigated, mobile]);

  // ─── What a click, a double-click and the keyboard do ──────────────────────

  /** A click picks the row: a database becomes current unless the active tab belongs to another. */
  const pick = (row: ConnectionTreeRow) => {
    if (row.kind === "folder") toggleFolder(row.name);
    else if (row.kind === "database") pickDatabase({ conn: row.conn.id, database: row.database });
    else if (row.kind === "connection") {
      const single = singleDbRef(row.conn);
      const open = row.status?.state === "open";
      if (single) {
        if (open) pickDatabase(single);
        else focusRow(single);
      } else {
        focusRow({ conn: row.conn.id, database: null });
        if (open) toggleConnectionExpanded(row.conn.id);
      }
    }
  };

  /** A double-click or Enter: connect, or make the database current — an explicit choice, so no question asked. */
  const activate = (row: ConnectionTreeRow) => {
    if (row.kind === "folder") toggleFolder(row.name);
    else if (row.kind === "database") void setCurrentDatabase({ conn: row.conn.id, database: row.database });
    else if (row.kind === "connection") {
      const single = singleDbRef(row.conn);
      if (single) void setCurrentDatabase(single);
      else {
        focusRow({ conn: row.conn.id, database: null });
        void connectConnection(row.conn.id, { expand: true });
      }
    }
  };

  const onRowClick = (row: ConnectionTreeRow, e: MouseEvent) => {
    setCursor(row.key);
    // The second click of a double-click: a folder has already been toggled by the first.
    if (e.detail >= 2) {
      if (row.kind !== "folder") activate(row);
      return;
    }
    pick(row);
  };

  const onKeyDown = useTreeKeys({
    rows, cursor, setCursor, listRef, focusable, depthOf,
    expand: (row) => {
      if (row.kind === "folder" && !row.open) { toggleFolder(row.name); return true; }
      if (row.kind === "connection" && !singleDbRef(row.conn) && !row.expanded) {
        if (row.expandable) toggleConnectionExpanded(row.conn.id);
        else void connectConnection(row.conn.id, { expand: true });
        return true;
      }
      return false;
    },
    collapse: (row) => {
      if (row.kind === "folder" && row.open) { toggleFolder(row.name); return true; }
      if (row.kind === "connection" && row.expanded) { toggleConnectionExpanded(row.conn.id); return true; }
      return false;
    },
    onEnter: activate,
    onSpace: pick,
  });

  // ─── The one context menu ──────────────────────────────────────────────────

  const menuFor = (key: string | null): MenuEntry[] | null => {
    const row = key ? rowsRef.current.find((r) => r.key === key) : undefined;
    if (!row) return null;
    if (row.kind === "connection") return connectionMenu(row.conn, row.status, actions);
    if (row.kind === "database") return databaseMenu(row.conn, row.database, row.current, actions);
    if (row.kind === "folder" && !row.renaming) return folderMenu(row.name, actions);
    return null;
  };
  const menu = useRowMenu(menuFor, setCursor);

  // ─── Folders typed in place ────────────────────────────────────────────────

  const commitNewFolder = (name: string) => {
    setCreatingFolder(false);
    if (!name.trim()) return;
    if (!createFolder(name)) toast.error(`A folder named “${name.trim()}” already exists`);
  };
  const commitRename = (from: string, name: string) => {
    setRenamingFolder(null);
    if (!name.trim() || name.trim() === from) return;
    renameFolder(from, name)
      .then((renamed) => { if (!renamed) toast.error(`A folder named “${name.trim()}” already exists`); })
      .catch((e) => toast.error(`Could not rename the folder: ${errorText(e)}`));
  };

  // ─── Toolbar ───────────────────────────────────────────────────────────────

  const filterEntries: MenuEntry[] = [
    { kind: "label", label: "Search by" },
    ...CONNECTION_SEARCH_FIELDS.map(({ field, label }): MenuEntry => ({
      kind: "check", label, checked: fields.includes(field),
      // The last field stays: a search looking at nothing would find nothing.
      disabled: fields.length === 1 && fields.includes(field),
      onToggle: () => setExplorerView({
        connectionSearch: fields.includes(field) ? fields.filter((f) => f !== field) : [...fields, field],
      }),
    })),
  ];

  const hasFolders = folderNames(connections, prefs.emptyFolders).length > 0;
  const nothing = loaded && !listError && connections.length === 0 && !hasFolders && !creatingFolder;
  const noMatch = searchFoundNothing(rows, query);
  const matchName = fields.includes("name") ? query : "";
  const matchDatabase = fields.includes("database") ? query : "";

  return (
    <section aria-label="Connections" className={cn("flex min-h-0 flex-col", className)} style={style}>
      <SectionHeader title="Connections" collapsed={collapsed} onToggle={onToggleCollapsed} />
      {!collapsed && (
        <>
          <div className="flex shrink-0 items-center gap-0.5 pr-1.5 pb-1.5 pl-2 max-md:gap-0 max-md:pr-1 max-md:pb-2 max-md:pl-2.5">
            <SearchBox value={query} onChange={setConnectionQuery} placeholder="Search connection or database" />
            <ToolbarMenu title="Search by" icon={Filter} entries={filterEntries} active={query.trim() !== ""} className={toolbarButtonClass} />
            <button type="button" title="Add new connection" aria-label="Add new connection" className={toolbarButtonClass}
              onClick={() => { openConnectionForm(); navigated(); }}>
              <Plus className="size-4" />
            </button>
            <button type="button" title="Add new connection folder" aria-label="Add new connection folder" className={toolbarButtonClass}
              onClick={() => { setRenamingFolder(null); setCreatingFolder(true); }}>
              <FolderPlus className="size-4" />
            </button>
            <button type="button" title="Refresh connection list" aria-label="Refresh connection list" className={toolbarButtonClass}
              onClick={() => void loadConnections()}>
              <RefreshCw className="size-4" />
            </button>
          </div>

          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={listRef}
                role="tree"
                aria-label="Connections"
                tabIndex={0}
                aria-activedescendant={cursor && rows.some((r) => r.key === cursor) ? treeRowDomId(idPrefix, cursor) : undefined}
                onKeyDown={onKeyDown}
                onFocus={(e) => {
                  if (e.target !== e.currentTarget || (cursor && rows.some((r) => r.key === cursor))) return;
                  const first = rows.find((r) => focusable(r) && "selected" in r && r.selected) ?? rows.find(focusable);
                  if (first) setCursor(first.key);
                }}
                {...menu.listProps}
                className="group/tree min-h-0 flex-1 overflow-y-auto pb-2.5 outline-none"
              >
                {!loaded && <EmptyState>Loading…</EmptyState>}
                {listError && (
                  <EmptyState>
                    <span className="text-error">{listError}</span>
                    <button type="button" className={linkButtonClass} onClick={() => void loadConnections()}>Retry</button>
                  </EmptyState>
                )}
                {nothing && (
                  <EmptyState>
                    No connections yet.
                    <Button size="sm" className="gap-1 max-md:min-h-11" onClick={() => { openConnectionForm(); navigated(); }}>
                      <Plus className="size-4" />Add new connection
                    </Button>
                  </EmptyState>
                )}
                {noMatch && (
                  <EmptyState>
                    No connection matches “{query.trim()}”.
                    <button type="button" className={linkButtonClass} onClick={() => setConnectionQuery("")}>Clear search</button>
                  </EmptyState>
                )}
                {rows.map((row) => (
                  <ConnectionTreeItem
                    key={row.key}
                    row={row}
                    domId={treeRowDomId(idPrefix, row.key)}
                    cursor={cursor === row.key}
                    flash={flashKey === row.key}
                    failureShownBelow={row.kind === "connection" && row.conn.id === shownBelow}
                    matchName={matchName}
                    matchDatabase={matchDatabase}
                    onClick={onRowClick}
                    onToggleExpanded={(id) => toggleConnectionExpanded(id)}
                    onNewFolder={commitNewFolder}
                    onCancelNewFolder={() => setCreatingFolder(false)}
                    onRename={commitRename}
                    onCancelRename={() => setRenamingFolder(null)}
                  />
                ))}
              </div>
            </ContextMenuTrigger>
            {menu.entries && <RowMenuContent entries={menu.entries} />}
          </ContextMenu>

          <DeleteConnectionDialog
            target={deleting}
            onCancel={() => setDeleting(null)}
            onConfirm={async (id) => {
              await deleteConnection(id);
              setDeleting(null);
            }}
          />
        </>
      )}
    </section>
  );
}

interface ItemProps {
  row: ConnectionTreeRow;
  domId: string;
  cursor: boolean;
  flash: boolean;
  /** The object list shows this connection's failure, so its row only marks it. */
  failureShownBelow: boolean;
  matchName: string;
  matchDatabase: string;
  onClick: (row: ConnectionTreeRow, e: MouseEvent) => void;
  onToggleExpanded: (id: number) => void;
  onNewFolder: (name: string) => void;
  onCancelNewFolder: () => void;
  onRename: (from: string, name: string) => void;
  onCancelRename: () => void;
}

function ConnectionTreeItem({
  row, domId, cursor, flash, failureShownBelow, matchName, matchDatabase, onClick, onToggleExpanded, onNewFolder, onCancelNewFolder, onRename, onCancelRename,
}: ItemProps) {
  switch (row.kind) {
    case "new-folder":
      return <FolderNameInput initial="" icon={FolderPlus} label="New folder name" onCommit={onNewFolder} onCancel={onCancelNewFolder} />;

    case "separator":
      return <div role="none" className="mx-2.5 my-[5px] h-px bg-border-soft" />;

    case "folder":
      if (row.renaming) {
        return <FolderNameInput initial={row.name} icon={Folder} label="Folder name" onCommit={(name) => onRename(row.name, name)} onCancel={onCancelRename} />;
      }
      return (
        <TreeRow id={domId} rowKey={row.key} depth={0} level={1} expanded={row.open} cursor={cursor}
          className="text-xs font-semibold max-md:text-[13px]" onClick={(e) => onClick(row, e)}>
          <span className="flex size-4 shrink-0 items-center justify-center text-text-subtle">
            {row.open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
          {row.open ? <FolderOpen className="size-[15px] shrink-0 text-text-subtle" /> : <Folder className="size-[15px] shrink-0 text-text-subtle" />}
          <span className="min-w-0 truncate">{row.name}</span>
          <RowTail>{row.count}</RowTail>
        </TreeRow>
      );

    case "connection": {
      const c = row.conn;
      const st = row.status;
      const title = [
        connectionWhere(c),
        c.readonly === 1 && "read-only",
        st?.state === "error" ? st.message : st?.state === "open" ? "connected" : st?.state === "connecting" ? "connecting…" : null,
      ].filter(Boolean).join(" · ");
      return (
        <>
          <TreeRow id={domId} rowKey={row.key} depth={row.depth} level={row.depth + 1} expanded={row.expandable ? row.expanded : undefined}
            selected={row.selected} cursor={cursor} flash={flash} title={title} onClick={(e) => onClick(row, e)}>
            <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-[3px] text-text-subtle"
              onClick={row.expandable ? (e) => { e.stopPropagation(); onToggleExpanded(c.id); } : undefined}>
              {row.expandable && (row.expanded ? <SquareMinus className="size-3.5" /> : <SquarePlus className="size-3.5" />)}
            </span>
            <DbEngineIcon type={c.type} className="size-4 max-md:size-[18px]" />
            {c.color && <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: c.color }} />}
            <span className={cn("min-w-0 truncate", row.current && "font-bold text-foreground")}>
              <Highlight text={c.name} query={matchName} />
            </span>
            <RowTail>{c.type}</RowTail>
            {c.readonly === 1 && <Lock className="size-[13px] shrink-0 text-text-subtle" aria-label="Read-only" />}
            {st?.state === "connecting" && <Loader2 className="size-3.5 shrink-0 animate-spin text-text-subtle" aria-label="Connecting" />}
            {st?.state === "open" && <CheckCircle className="size-3.5 shrink-0 text-success" aria-label="Connected" />}
            {st?.state === "error" && <AlertCircle className="size-3.5 shrink-0 text-error" aria-label={`Error: ${st.message}`} />}
          </TreeRow>
          {st?.state === "error" && st.driver && !failureShownBelow && (
            <div role="none" className="pl-6"><DriverMissingNotice compact driver={st.driver} /></div>
          )}
        </>
      );
    }

    case "database":
      return (
        <TreeRow id={domId} rowKey={row.key} depth={row.depth} level={row.depth + 1} selected={row.selected} cursor={cursor}
          onClick={(e) => onClick(row, e)}>
          <span className="size-4 shrink-0" />
          <Database className="size-[15px] shrink-0 text-text-subtle" />
          <span className={cn("min-w-0 truncate", row.current && "font-bold text-foreground")}>
            <Highlight text={row.database} query={matchDatabase} />
          </span>
        </TreeRow>
      );

    case "databases-loading":
      return (
        <div role="none" style={{ "--d": row.depth } as CSSProperties}
          className="mx-1 flex h-[26px] items-center gap-[5px] pl-[calc(2px+var(--d)*16px)] text-xs text-text-subtle max-md:h-11 max-md:pl-[calc(6px+var(--d)*18px)]">
          <span className="size-4 shrink-0" />
          <Loader2 className="size-3.5 animate-spin" />Loading databases…
        </div>
      );

    case "databases-error":
      return (
        <div role="none" style={{ "--d": row.depth } as CSSProperties} title={row.message}
          className="mx-1 flex min-h-[26px] items-start gap-[5px] py-1 pr-1.5 pl-[calc(2px+var(--d)*16px)] text-xs text-error max-md:min-h-11 max-md:pl-[calc(6px+var(--d)*18px)]">
          <span className="size-4 shrink-0" />
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{row.message}</span>
        </div>
      );
  }
}
