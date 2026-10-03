/**
 * The database tabs, each opened on a place: a table's data, its structure, one object's SQL, and
 * a new query. A tab records `database` only when it is not the connection's own, so one table
 * opened from the tree, the command palette, a foreign key or another tab's toolbar lands on the
 * same tab (see `dbTabId`).
 */
import { useTabStore } from "@/stores/tab-store";
import { usePanelStore } from "@/stores/panel-store";
import { randomId } from "@/lib/utils";
import { dbObjectTabTitle, nextQueryNumber, queryTabMetadata, targetFields, type DbTarget } from "@/lib/db-tabs";
import { newTableTabMetadata, nextTableNumber } from "@/lib/db-table-edit";
import type { DbObject, DbObjectKind } from "../../../../shared/db-structure";
import { newTableModel } from "../../../../shared/db-table-model";
import { withTabFilters, type GridFilters } from "../grid/grid-filters";
import { DEFAULT_TABLE_VIEW, withTabView } from "../grid/table-view-state";
import type { DbType } from "../../../../shared/db-types";
import { tabDatabase, type DbRef, type TreeConnection } from "./explorer-model";

/** Where a tab is, and what it shows of it before the connection list has arrived. */
export interface DbTabPlace {
  target: DbTarget;
  connectionName?: string;
  dbType?: DbType;
  connectionColor?: string | null;
}

/** The place of a tab opened from the tree on `ref`. */
export function treePlace(conn: TreeConnection, ref: DbRef): DbTabPlace {
  const database = tabDatabase(ref, conn);
  return {
    target: { kind: "connection", connectionId: conn.id, ...(database ? { database } : {}) },
    connectionName: conn.name, dbType: conn.type, connectionColor: conn.color,
  };
}

/** The place a tab's own metadata names, for the tabs it opens in turn. */
export function placeOf(target: DbTarget, metadata: Record<string, unknown> | undefined): DbTabPlace {
  const name = metadata?.connectionName;
  const color = metadata?.connectionColor;
  return {
    target,
    ...(typeof name === "string" ? { connectionName: name } : {}),
    ...(typeof metadata?.dbType === "string" ? { dbType: metadata.dbType as DbType } : {}),
    ...(typeof color === "string" ? { connectionColor: color } : {}),
  };
}

function placeFields(p: DbTabPlace): Record<string, unknown> {
  return {
    ...targetFields(p.target),
    ...(p.connectionName ? { connectionName: p.connectionName } : {}),
    ...(p.dbType ? { dbType: p.dbType } : {}),
    ...(p.connectionColor ? { connectionColor: p.connectionColor } : {}),
  };
}

/** A file inside a project is that project's; everything else shows in every project's workspace. */
function projectOf(p: DbTabPlace): string | null {
  return p.target.kind === "file" ? p.target.projectName ?? null : null;
}

/** A table, view or materialized view; `kind` is what the tab asks the SQL tab for, when known. */
export interface DbRelation {
  schema: string | null;
  name: string;
  kind?: DbObjectKind;
}

function relationTab(type: "database" | "db-structure", place: DbTabPlace, rel: DbRelation, panelId?: string): string {
  return usePanelStore.getState().openTab({
    type,
    title: dbObjectTabTitle(place.target, place.connectionName, rel.name),
    projectId: projectOf(place),
    closable: true,
    metadata: { ...placeFields(place), schemaName: rel.schema ?? "", tableName: rel.name, ...(rel.kind ? { objectKind: rel.kind } : {}) },
  }, panelId);
}

export function openTableTab(place: DbTabPlace, rel: DbRelation): string {
  return relationTab("database", place, rel);
}

/**
 * DBGate's form button on a foreign key: the referenced table as a form, filtered to the rows
 * `filters` name, in a tab of its own — never one already open, as DBGate forces a new tab.
 */
export function openReferenceTab(place: DbTabPlace, rel: DbRelation, filters: GridFilters): string {
  const metadata = { ...placeFields(place), schemaName: rel.schema ?? "", tableName: rel.name, instance: randomId() };
  return usePanelStore.getState().openTab({
    type: "database",
    title: dbObjectTabTitle(place.target, place.connectionName, rel.name),
    projectId: projectOf(place),
    closable: true,
    metadata: withTabView(withTabFilters(metadata, filters), { ...DEFAULT_TABLE_VIEW, form: true }),
  });
}

/** A table's Structure tab, in the focused panel or in `panelId`. */
export function openStructureTab(place: DbTabPlace, rel: DbRelation, panelId?: string): string {
  return relationTab("db-structure", place, rel, panelId);
}

/**
 * The Structure tab of `rel` where the tab `tabId` is — its panel, its place in the strip — and
 * that tab closed: a New table becoming the table its Save created.
 */
export function openStructureTabInPlaceOf(tabId: string, place: DbTabPlace, rel: DbRelation): string {
  const panel = usePanelStore.getState().getPanelForTab(tabId);
  const index = panel ? panel.tabs.findIndex((t) => t.id === tabId) : -1;
  const id = openStructureTab(place, rel, panel?.id);
  if (!panel) return id;
  usePanelStore.getState().closeTab(tabId, panel.id);
  if (index >= 0) usePanelStore.getState().reorderTab(id, panel.id, index);
  return id;
}

/**
 * DBGate's New table: a Structure tab, "Table #N", on a table that exists only in the tab until
 * its Save creates it — `new_table` with an `id` column, in `schema` (Postgres).
 */
export function openNewTableTab(place: DbTabPlace, schema: string | null): string {
  const tableNumber = nextTableNumber(Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs));
  return useTabStore.getState().openTab({
    type: "db-structure",
    title: `Table #${tableNumber}`,
    projectId: projectOf(place),
    closable: true,
    metadata: { ...placeFields(place), ...newTableTabMetadata(newTableModel(schema), tableNumber, randomId()) },
  });
}

/** One object's SQL. `args` tells a routine's overloads apart, `table` which table a trigger is on. */
export function openSqlTab(place: DbTabPlace, o: Pick<DbObject, "schema" | "name" | "kind" | "args" | "table">): string {
  return useTabStore.getState().openTab({
    type: "db-sql",
    title: dbObjectTabTitle(place.target, place.connectionName, o.name),
    projectId: projectOf(place),
    closable: true,
    metadata: {
      ...placeFields(place), schemaName: o.schema ?? "", objectKind: o.kind, objectName: o.name,
      ...(o.args !== undefined ? { objectArgs: o.args } : {}), ...(o.table ? { objectTable: o.table } : {}),
    },
  });
}

/**
 * A new query tab on `place`, its editor holding `sql`. It runs nothing unless `run` says so: a
 * template or a script is there to be edited first, and only SQL the app wrote itself to read
 * something — a foreign key followed — is run on the way in.
 */
export function openQueryTab(place: DbTabPlace, sql: string, opts: { run?: boolean } = {}): string {
  const queryNumber = nextQueryNumber(Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs));
  return useTabStore.getState().openTab({
    type: "db-query",
    title: `Query ${queryNumber}`,
    projectId: projectOf(place),
    closable: true,
    metadata: { ...placeFields(place), ...queryTabMetadata(sql, queryNumber, opts) },
  });
}
