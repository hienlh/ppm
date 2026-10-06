/**
 * DBGate's TABLES, VIEWS, FUNCTIONS widget: what the current database holds, grouped by kind, a
 * table's or view's columns under it once expanded, with a search that can look at names, the
 * schema, column names and column types. The list belongs to the current database — the one the
 * active tab is on — so a database picked under Connections replaces it with a question rather
 * than with that database's objects (`FocusedDatabasePrompt`).
 *
 * One context menu serves the whole list, as in the Connections section.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ElementType, type MouseEvent } from "react";
import {
  AlertCircle, ChevronDown, ChevronRight, Code, Eye, FileText, Filter, Info, Key, Layers, Link, ListOrdered, Loader2,
  MoreVertical, Plus, Table, Zap,
} from "@/lib/icons";
import { DbEngineIcon } from "@/lib/file-icons";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { DbObject, DbObjectKind } from "../../../../shared/db-structure";
import {
  loadAllColumns, loadObjects, loadTableStructure, setCurrentDatabase, setExplorerView, setObjectExpanded, setObjectQuery,
  toggleObjectGroup, useDbExplorer,
} from "../explorer/db-explorer-store";
import {
  KINDS_WITH_COLUMNS, columnsByTable, dbKey, focusDiffers, formatRowEstimate, hasSchemaChoice, initialSchema, schemaOptions,
  searchNeedsColumns, type ObjectFilter, type ObjectSearchField,
} from "../explorer/explorer-model";
import { RowMenuContent, ToolbarMenu, type MenuEntry } from "../explorer/explorer-menu";
import { EmptyState, Highlight, RowTail, SearchBox, SectionHeader, TreeRow, linkButtonClass, toolbarButtonClass } from "../explorer/tree-parts";
import { treeRowDomId, useTreeKeys } from "../explorer/use-tree-keys";
import { useRowMenu } from "../explorer/use-row-menu";
import { openSqlTab, openTableTab, treePlace } from "../explorer/open-db-tabs";
import { openNewTable } from "../explorer/open-new-table";
import { DriverMissingNotice } from "../driver-missing-notice";
import { FocusedDatabasePrompt, databaseLabel } from "../focused-database-prompt";
import { GROUP_PAGE, GROUP_PAGE_MORE, objectTreeRows, structuresToRead, type ObjectTreeRow } from "./object-tree-model";
import { columnMenu, moreMenu, newObjectMenu, objectMenu, type ObjectMenuActions } from "./object-menus";

const KIND_ICONS: Record<DbObjectKind, ElementType> = {
  table: Table, view: Eye, matview: Layers, procedure: FileText, function: Code, trigger: Zap, sequence: ListOrdered,
};

const SEARCH_FIELDS: { field: ObjectSearchField; label: string }[] = [
  { field: "name", label: "Table, view or routine name" },
  { field: "schema", label: "Schema" },
  { field: "column", label: "Column name" },
  { field: "type", label: "Column data type" },
];
const KNOWN_FIELDS = new Set<string>(SEARCH_FIELDS.map((f) => f.field));

const focusable = (r: ObjectTreeRow) => r.kind === "group" || r.kind === "object" || r.kind === "column" || r.kind === "more";
const depthOf = (r: ObjectTreeRow) => (r.kind === "group" ? 0 : r.kind === "object" || r.kind === "more" ? 1 : 2);
const opensData = (o: DbObject) => KINDS_WITH_COLUMNS.has(o.kind);

interface ObjectsSectionProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Called once the section opened a tab: the phone's drawer closes so the tab can be seen. */
  onNavigate?: () => void;
  className?: string;
  style?: CSSProperties;
}

export function ObjectsSection({ collapsed, onToggleCollapsed, onNavigate, className, style }: ObjectsSectionProps) {
  const connections = useDbExplorer((s) => s.connections);
  const status = useDbExplorer((s) => s.status);
  const objects = useDbExplorer((s) => s.objects);
  const allColumns = useDbExplorer((s) => s.allColumns);
  const structures = useDbExplorer((s) => s.structures);
  const focused = useDbExplorer((s) => s.focused);
  const query = useDbExplorer((s) => s.objectQuery);
  const prefs = useSettingsStore((s) => s.dbExplorer);
  const view = useSettingsStore((s) => s.dbExplorerView);

  const current = view.current;
  const conn = current ? connections.find((c) => c.id === current.conn) : undefined;
  const key = current && conn ? dbKey(current) : null;
  const diff = focusDiffers(focused, current, (id) => connections.some((c) => c.id === id));
  const connStatus = conn ? status[conn.id] : undefined;
  const listState = key ? objects[key] : undefined;
  const list = listState?.state === "ready" ? listState.data : null;

  const options = useMemo(() => (list ? schemaOptions(list) : []), [list]);
  const schemaChoice = !!conn && hasSchemaChoice(conn.type) && options.length > 0;
  const schema = schemaChoice && key ? initialSchema(options, view.schemas[key]) : null;

  // Searching by schema means nothing where there is no schema to choose; the name stays when nothing else is left.
  const fields = useMemo(() => {
    const known = view.objectSearch.filter((f): f is ObjectSearchField => KNOWN_FIELDS.has(f) && (f !== "schema" || schemaChoice));
    return known.length ? known : (["name"] as ObjectSearchField[]);
  }, [view.objectSearch, schemaChoice]);
  const needsColumns = searchNeedsColumns({ query, fields });
  const columnsState = key ? allColumns[key] : undefined;
  const columns = useMemo(
    () => (needsColumns && columnsState?.state === "ready" ? columnsByTable(columnsState.data) : undefined),
    [needsColumns, columnsState],
  );
  const filter: ObjectFilter = useMemo(
    () => ({ query, fields, columns, onlyWithRows: view.onlyWithRows, sort: view.objectSort }),
    [query, fields, columns, view.onlyWithRows, view.objectSort],
  );

  // "Show more" counts belong to one database and schema.
  const pagingKey = `${key}|${schema ?? ""}`;
  const [paging, setPaging] = useState<{ at: string; shown: Partial<Record<DbObjectKind, number>> }>({ at: "", shown: {} });
  const shown = paging.at === pagingKey ? paging.shown : {};
  const [cursor, setCursor] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();

  const expandedObjects = useMemo(() => new Set(prefs.expandedObjects), [prefs.expandedObjects]);
  const rows = useMemo(
    () => (current && list ? objectTreeRows({ ref: current, list, schema, filter, openGroups: prefs.openGroups, expandedObjects, structures, shown }) : []),
    [current, list, schema, filter, prefs.openGroups, expandedObjects, structures, shown],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // What the rows need read: the object list of an open connection, every column for a search by
  // column, and the structure of each table expanded by hand.
  const open = connStatus?.state === "open";
  useEffect(() => {
    if (current && conn && open && !listState) void loadObjects(current);
  }, [current, conn, open, listState]);
  useEffect(() => {
    if (current && list && needsColumns && !columnsState) void loadAllColumns(current);
  }, [current, list, needsColumns, columnsState]);
  useEffect(() => {
    if (!current) return;
    for (const { nodeKey, object } of structuresToRead(rows, structures)) void loadTableStructure(current, nodeKey, object);
  }, [current, rows, structures]);

  const navigated = useCallback(() => onNavigate?.(), [onNavigate]);
  const mobile = useIsMobile();
  const actions: ObjectMenuActions = useMemo(() => ({ navigated, editsStructure: !mobile, impExp: !mobile }), [navigated, mobile]);
  // DBGate's New table where a database has none, on a desktop and a connection that takes writes.
  const newTable = conn && current && !mobile && conn.readonly !== 1 ? () => { openNewTable(conn, current); navigated(); } : undefined;
  const searching = query.trim() !== "";

  const showMore = (kind: DbObjectKind) => setPaging({
    at: pagingKey, shown: { ...shown, [kind]: (shown[kind] ?? GROUP_PAGE) + GROUP_PAGE_MORE },
  });
  /** What a click opens, as in DBGate: a table's or view's data, anything else its SQL. */
  const openObject = (o: DbObject) => {
    if (!conn || !current) return;
    if (opensData(o)) openTableTab(treePlace(conn, current), o);
    else openSqlTab(treePlace(conn, current), o);
    navigated();
  };
  const toggleColumns = (row: Extract<ObjectTreeRow, { kind: "object" }>) => setObjectExpanded(row.nodeKey, !expandedObjects.has(row.nodeKey));

  // ─── What a click and the keyboard do ──────────────────────────────────────

  /** A click: a group opens or closes, a table or view opens its data, anything else its SQL. */
  const pick = (row: ObjectTreeRow) => {
    if (row.kind === "group") { if (!searching) toggleObjectGroup(row.group); }
    else if (row.kind === "more") showMore(row.group);
    else if (row.kind === "object") {
      setPicked(row.key);
      openObject(row.object);
    }
  };

  const onRowClick = (row: ObjectTreeRow, e: MouseEvent) => {
    setCursor(row.key);
    // The second click of a double-click: the first has done it already.
    if (e.detail >= 2) return;
    pick(row);
  };

  const onKeyDown = useTreeKeys({
    rows, cursor, setCursor, listRef, focusable, depthOf,
    expand: (row) => {
      if (row.kind === "group" && !row.open) { toggleObjectGroup(row.group); return true; }
      if (row.kind === "object" && row.expandable && !row.expanded) { toggleColumns(row); return true; }
      return false;
    },
    collapse: (row) => {
      if (row.kind === "group" && row.open && !searching) { toggleObjectGroup(row.group); return true; }
      if (row.kind === "object" && expandedObjects.has(row.nodeKey)) { toggleColumns(row); return true; }
      return false;
    },
    onEnter: pick,
    onSpace: pick,
  });

  // ─── The one context menu ──────────────────────────────────────────────────

  const menuFor = (rowKey: string | null): MenuEntry[] | null => {
    const row = rowKey ? rowsRef.current.find((r) => r.key === rowKey) : undefined;
    if (!row || !conn || !current) return null;
    if (row.kind === "object") return objectMenu(conn, current, row.object, actions);
    if (row.kind === "column") {
      const owner = rowsRef.current.find((r): r is Extract<ObjectTreeRow, { kind: "object" }> => r.kind === "object" && r.key === row.objectKey);
      return columnMenu(conn, current, owner?.object, row.column.name, actions);
    }
    return null;
  };
  const menu = useRowMenu(menuFor, setCursor);

  // ─── Toolbar ───────────────────────────────────────────────────────────────

  const offered = SEARCH_FIELDS.filter((f) => f.field !== "schema" || schemaChoice);
  const filterEntries: MenuEntry[] = [
    { kind: "label", label: "Search by" },
    ...offered.map(({ field, label }): MenuEntry => ({
      kind: "check", label, checked: fields.includes(field),
      // The last field stays: a search looking at nothing would find nothing.
      disabled: fields.length === 1 && fields.includes(field),
      onToggle: () => setExplorerView({ objectSearch: fields.includes(field) ? fields.filter((f) => f !== field) : [...fields, field] }),
    })),
    { kind: "separator" },
    { kind: "check", label: "Only tables with rows", checked: view.onlyWithRows, onToggle: () => setExplorerView({ onlyWithRows: !view.onlyWithRows }) },
    { kind: "separator" },
    { kind: "label", label: "Sort by" },
    {
      kind: "radio", value: view.objectSort,
      options: [{ value: "name", label: "Name" }, { value: "rows", label: "Row count" }],
      onChange: (v) => setExplorerView({ objectSort: v === "rows" ? "rows" : "name" }),
    },
  ];

  const dbName = conn && current ? databaseLabel(conn, current) : null;
  const matchName = fields.includes("name") ? query : "";
  const matchColumn = fields.includes("column") ? query : "";

  return (
    <section aria-label="Tables, views, functions" className={cn("flex min-h-0 flex-col", className)} style={style}>
      <SectionHeader title="Tables, views, functions" collapsed={collapsed} onToggle={onToggleCollapsed}>
        {conn && dbName && (
          <span title={`${conn.name} · ${dbName}`}
            className="ml-auto inline-flex max-w-[60%] shrink-0 items-center gap-[5px] font-mono text-[11px] font-medium tracking-normal text-text-subtle normal-case max-md:text-xs">
            <DbEngineIcon type={conn.type} className="size-3.5" />
            <span className="min-w-0 truncate">{dbName}</span>
          </span>
        )}
      </SectionHeader>
      {!collapsed && (
        <>
          <div className="flex shrink-0 items-center gap-0.5 pr-1.5 pb-1.5 pl-2 max-md:gap-0 max-md:pr-1 max-md:pb-2 max-md:pl-2.5">
            <SearchBox value={query} onChange={setObjectQuery} placeholder="Search in tables, views, procedures" />
            <ToolbarMenu title="Search by, sort by" icon={Filter} entries={filterEntries} active={searching} className={toolbarButtonClass} />
            {conn && current && !searching && (
              <ToolbarMenu title="New object" icon={Plus} entries={newObjectMenu(conn, current, actions)} className={toolbarButtonClass} />
            )}
            {conn && current && <ToolbarMenu title="More" icon={MoreVertical} entries={moreMenu(conn, current)} className={toolbarButtonClass} />}
          </div>

          {diff && focused ? (
            <FocusedDatabasePrompt focused={focused} current={conn ? current : null} />
          ) : (
            <>
              {schemaChoice && key && schema !== null && (
                <div className="flex shrink-0 items-center gap-2 pr-2 pb-1.5 pl-2.5 text-xs text-text-secondary max-md:pr-2.5 max-md:pb-2 max-md:pl-3 max-md:text-[13px]">
                  <label htmlFor={`${idPrefix}-schema`}>Schema</label>
                  <span className="relative flex min-w-0 flex-1">
                    <select id={`${idPrefix}-schema`} value={schema}
                      onChange={(e) => setExplorerView({ schemas: { ...view.schemas, [key]: e.target.value } })}
                      className="h-[26px] w-full min-w-0 appearance-none rounded-[5px] border border-border bg-input pr-[26px] pl-2 font-mono text-xs text-foreground outline-none focus:border-primary max-md:h-11 max-md:text-sm">
                      {options.map((o) => <option key={o.schema} value={o.schema}>{o.schema} ({o.count})</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-text-subtle" />
                  </span>
                </div>
              )}

              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    ref={listRef}
                    role="tree"
                    aria-label="Tables, views, functions"
                    tabIndex={0}
                    aria-activedescendant={cursor && rows.some((r) => r.key === cursor) ? treeRowDomId(idPrefix, cursor) : undefined}
                    onKeyDown={onKeyDown}
                    onFocus={(e) => {
                      if (e.target !== e.currentTarget || (cursor && rows.some((r) => r.key === cursor))) return;
                      const first = rows.find((r) => r.key === picked) ?? rows.find(focusable);
                      if (first) setCursor(first.key);
                    }}
                    {...menu.listProps}
                    className="group/tree min-h-0 flex-1 overflow-y-auto pb-2.5 outline-none"
                  >
                    <ListState
                      hasCurrent={!!conn && !!current}
                      connName={conn?.name ?? ""}
                      connStatus={connStatus}
                      listState={listState}
                      searching={searching}
                      query={query}
                      emptyName={schema ?? dbName ?? ""}
                      hasRows={rows.length > 0}
                      hiddenByRows={view.onlyWithRows && !!list && list.objects.some((o) => schema === null || o.schema === schema)}
                      readingColumns={needsColumns && columnsState?.state === "loading"}
                      columnsError={needsColumns && columnsState?.state === "error" ? columnsState.message : null}
                      onRetry={() => { if (current) void (listState?.state === "error" ? loadObjects(current, { force: true }) : setCurrentDatabase(current, { focus: false })); }}
                      onNewTable={newTable}
                    />
                    {rows.map((row) => (
                      <ObjectTreeItem
                        key={row.key}
                        row={row}
                        domId={treeRowDomId(idPrefix, row.key)}
                        cursor={cursor === row.key}
                        selected={picked === row.key}
                        matchName={matchName}
                        matchColumn={matchColumn}
                        onClick={onRowClick}
                        onToggleColumns={toggleColumns}
                        onRetryColumns={(objectKey) => {
                          const owner = rows.find((r): r is Extract<ObjectTreeRow, { kind: "object" }> => r.kind === "object" && r.key === objectKey);
                          if (owner && current) void loadTableStructure(current, owner.nodeKey, owner.object);
                        }}
                      />
                    ))}
                  </div>
                </ContextMenuTrigger>
                {menu.entries && <RowMenuContent entries={menu.entries} />}
              </ContextMenu>
              {rows.length > 0 && (
                <div className="mx-3.5 mt-2 mb-2.5 hidden shrink-0 items-center gap-1.5 text-xs text-text-subtle max-md:flex">
                  <Info className="size-3.5" />Long-press any row for its menu
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

interface ListStateProps {
  hasCurrent: boolean;
  connName: string;
  connStatus: ReturnType<typeof useDbExplorer.getState>["status"][number] | undefined;
  listState: ReturnType<typeof useDbExplorer.getState>["objects"][string] | undefined;
  searching: boolean;
  query: string;
  /** The schema or database named when there is nothing in it. */
  emptyName: string;
  hasRows: boolean;
  /** "Only tables with rows" is what left the list empty. */
  hiddenByRows: boolean;
  readingColumns: boolean;
  columnsError: string | null;
  onRetry: () => void;
  /** Offered where the database has no tables; absent where no table can be created. */
  onNewTable?: () => void;
}

/** What the list says above its rows, or instead of them: nothing picked, connecting, a failure, nothing found. */
function ListState(p: ListStateProps) {
  if (!p.hasCurrent) {
    return <EmptyState>No database selected. Click a database under Connections to list its tables.</EmptyState>;
  }
  const failure = p.listState?.state === "error" ? p.listState : p.connStatus?.state === "error" ? p.connStatus : null;
  if (failure) {
    return (
      <EmptyState>
        {/* A missing driver's notice says what went wrong itself; its message would only repeat it with a CLI hint. */}
        <span className="text-error">Error connecting {p.connName}{failure.driver ? "" : `: ${failure.message}`}</span>
        {failure.driver && <DriverMissingNotice compact driver={failure.driver} />}
        <button type="button" className={linkButtonClass} onClick={p.onRetry}>Retry</button>
      </EmptyState>
    );
  }
  if (p.listState?.state !== "ready") {
    return (
      <EmptyState>
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin" />
          {p.connStatus?.state === "connecting" ? `Connecting to ${p.connName}…` : "Loading…"}
        </span>
      </EmptyState>
    );
  }
  if (p.readingColumns) {
    return <EmptyState><span className="inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" />Reading columns…</span></EmptyState>;
  }
  if (p.columnsError) return <EmptyState><span className="text-error">Could not read the columns: {p.columnsError}</span></EmptyState>;
  if (p.hasRows) return null;
  if (p.searching) {
    return (
      <EmptyState>
        No table, view or routine matches “{p.query.trim()}”.
        <button type="button" className={linkButtonClass} onClick={() => setObjectQuery("")}>Clear search</button>
      </EmptyState>
    );
  }
  if (p.hiddenByRows) {
    return (
      <EmptyState>
        No table in {p.emptyName} has rows.
        <button type="button" className={linkButtonClass} onClick={() => setExplorerView({ onlyWithRows: false })}>Show every table</button>
      </EmptyState>
    );
  }
  return (
    <EmptyState>
      {p.emptyName} has no tables yet.
      {p.onNewTable && <button type="button" className={linkButtonClass} onClick={p.onNewTable}>New table</button>}
    </EmptyState>
  );
}

interface ItemProps {
  row: ObjectTreeRow;
  domId: string;
  cursor: boolean;
  selected: boolean;
  matchName: string;
  matchColumn: string;
  onClick: (row: ObjectTreeRow, e: MouseEvent) => void;
  onToggleColumns: (row: Extract<ObjectTreeRow, { kind: "object" }>) => void;
  onRetryColumns: (objectKey: string) => void;
}

const subRowClass = "mx-1 flex min-h-6 items-center gap-[5px] pr-1.5 pl-[calc(2px+var(--d)*16px)] text-xs max-md:min-h-10 max-md:pl-[calc(6px+var(--d)*18px)]";

function ObjectTreeItem({ row, domId, cursor, selected, matchName, matchColumn, onClick, onToggleColumns, onRetryColumns }: ItemProps) {
  switch (row.kind) {
    case "group":
      return (
        <TreeRow id={domId} rowKey={row.key} depth={0} level={1} expanded={row.open} cursor={cursor}
          className="text-xs font-semibold max-md:text-[13px]" onClick={(e) => onClick(row, e)}>
          <span className="flex size-4 shrink-0 items-center justify-center text-text-subtle">
            {row.open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
          <span className="min-w-0 truncate">{row.label}</span>
          <RowTail>{row.count}</RowTail>
        </TreeRow>
      );

    case "object": {
      const o = row.object;
      const Icon = KIND_ICONS[o.kind];
      return (
        <TreeRow id={domId} rowKey={row.key} depth={1} level={2} expanded={row.expandable ? row.expanded : undefined}
          selected={selected} cursor={cursor} title={o.kind === "trigger" && o.table ? `${o.name} on ${o.table}` : undefined}
          onClick={(e) => onClick(row, e)}>
          <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-[3px] text-text-subtle"
            onClick={row.expandable ? (e) => { e.stopPropagation(); onToggleColumns(row); } : undefined}>
            {row.expandable && (row.expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />)}
          </span>
          <Icon className={cn("size-[15px] shrink-0 text-text-subtle", selected && "text-primary")} />
          <span className="min-w-0 truncate">
            <Highlight text={o.name} query={matchName} />
            {row.showArgs && <span className="text-text-subtle">({o.args})</span>}
          </span>
          {/* The engine's statistics, not a count: MySQL's can be off by half. */}
          {o.rowEstimate !== undefined && <RowTail title="Estimated row count">{formatRowEstimate(o.rowEstimate)}</RowTail>}
        </TreeRow>
      );
    }

    case "column": {
      const c = row.column;
      return (
        <TreeRow id={domId} rowKey={row.key} depth={2} level={3} cursor={cursor} title={c.fk ? `→ ${c.fk}` : undefined}
          className="h-6 text-xs text-text-subtle max-md:h-10 max-md:text-[13px]" onClick={(e) => onClick(row, e)}>
          <span className="size-4 shrink-0" />
          {c.pk ? <Key className="size-[15px] shrink-0 text-warning" aria-label="Primary key" />
            : c.fk ? <Link className="size-[15px] shrink-0 text-info" aria-label="Foreign key" />
            : <span aria-hidden="true" className="grid w-[15px] shrink-0 place-items-center"><span className="size-1 rounded-full bg-text-subtle opacity-60" /></span>}
          <span className="min-w-0 truncate text-text-secondary"><Highlight text={c.name} query={matchColumn} /></span>
          {/* A long type (`timestamp with time zone`) gives way before the column's name does. */}
          <RowTail title={c.type} className="min-w-[4ch] shrink-[1000] truncate font-mono text-[10.5px] max-md:text-[11.5px]">{c.type}</RowTail>
        </TreeRow>
      );
    }

    case "columns-loading":
      return (
        <div role="none" style={{ "--d": 2 } as CSSProperties} className={cn(subRowClass, "text-text-subtle")}>
          <span className="size-4 shrink-0" />
          <Loader2 className="size-3.5 animate-spin" />Loading columns…
        </div>
      );

    case "columns-error":
      return (
        <div role="none" style={{ "--d": 2 } as CSSProperties} title={row.message} className={cn(subRowClass, "py-1 text-error")}>
          <span className="size-4 shrink-0" />
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{row.message}</span>
          <button type="button" className={cn(linkButtonClass, "ml-auto shrink-0")} onClick={() => onRetryColumns(row.objectKey)}>Retry</button>
        </div>
      );

    case "more":
      return (
        <TreeRow id={domId} rowKey={row.key} depth={1} level={2} cursor={cursor} className="text-xs text-primary max-md:text-[13px]"
          onClick={(e) => onClick(row, e)}>
          <span className="size-4 shrink-0" />
          <span className="min-w-0 truncate">Show {Math.min(row.hidden, GROUP_PAGE_MORE).toLocaleString("en-US")} more</span>
          <RowTail>{row.hidden.toLocaleString("en-US")} left</RowTail>
        </TreeRow>
      );
  }
}
