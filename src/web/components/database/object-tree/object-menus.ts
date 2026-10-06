/**
 * What the Tables, views, functions section's menus offer: per kind of object its data, structure
 * and SQL tabs, the + menu's New table, new query and CREATE templates, and ⋮'s refresh and
 * reconnect. A table's structure commands (Drop, Rename, Truncate, Create table backup; Rename and
 * Drop of a column) go through Save changes, and are left out on a connection that refuses writes
 * and on a phone, where the table editor is not.
 */
import { toast } from "sonner";
import {
  ArrowRightFromLine, ChevronsDownUp, Code, Copy, FileCode, FolderTree, Pencil, Power, RefreshCw, RotateCw, Table, Trash2, Upload,
} from "@/lib/icons";
import { api } from "@/lib/api-client";
import { copyToClipboard } from "@/lib/clipboard";
import { tidyMenu, type MenuEntry } from "../explorer/explorer-menu";
import {
  collapseAllObjects, disconnectConnection, reconnectConnection, refreshDatabase,
} from "../explorer/db-explorer-store";
import { databaseParam, withDatabaseParam, type DbRef, type TreeConnection } from "../explorer/explorer-model";
import { openQueryTab, openSqlTab, openStructureTab, openTableTab, treePlace } from "../explorer/open-db-tabs";
import { openNewTable } from "../explorer/open-new-table";
import {
  callTemplate, createRoutineTemplate, createTriggerTemplate, createViewTemplate, qualifiedName, routineTemplateKind, selectTemplate,
} from "../explorer/sql-templates";
import { askNewName, requestStructureChange } from "../table-editor/structure-save-store";
import { openTreeExport, openTreeImport } from "../impexp/open-impexp-tab";
import type { DbObject } from "../../../../shared/db-structure";
import { backupTableName, type StructureChange } from "../../../../shared/db-structure-change";

export interface ObjectMenuActions {
  /** Opened a tab: the phone's drawer gets out of its way. */
  navigated: () => void;
  /** The device changes structure — a desktop; a phone only looks at it. */
  editsStructure: boolean;
  /** The device opens the Import/Export tab — a desktop. */
  impExp: boolean;
}

/** Structure commands are offered: on a desktop, through a connection that takes writes. */
const changesStructure = (conn: TreeConnection, a: ObjectMenuActions) => a.editsStructure && conn.readonly !== 1;

function saveChange(conn: TreeConnection, ref: DbRef, change: StructureChange): void {
  const place = treePlace(conn, ref);
  requestStructureChange({ target: place.target, place, change });
}

/** DBGate's Drop table, Rename table, Truncate table and Create table backup, in its order. */
function tableStructureEntries(conn: TreeConnection, ref: DbRef, o: DbObject): MenuEntry[] {
  const at = { schema: o.schema, table: o.name };
  return [
    { kind: "item", label: "Drop table", icon: Trash2, destructive: true, onSelect: () => saveChange(conn, ref, { kind: "drop-table", ...at }) },
    {
      kind: "item", label: "Rename table", icon: Pencil,
      onSelect: () => askNewName({ value: o.name, onConfirm: (newName) => saveChange(conn, ref, { kind: "rename-table", ...at, newName }) }),
    },
    { kind: "item", label: "Truncate table", onSelect: () => saveChange(conn, ref, { kind: "truncate-table", ...at }) },
    { kind: "item", label: "Create table backup", onSelect: () => saveChange(conn, ref, { kind: "backup-table", ...at, newName: backupTableName(o.name, new Date()) }) },
  ];
}

async function copyName(name: string): Promise<void> {
  if (await copyToClipboard(name)) toast.success(`Copied “${name}”`);
  else toast.error("The clipboard is not available here");
}

/** A materialized view's rows computed again, as DBGate's Refresh data does. */
async function refreshMaterializedView(conn: TreeConnection, ref: DbRef, o: DbObject): Promise<void> {
  const url = withDatabaseParam(`/api/db/connections/${conn.id}/query`, databaseParam(ref, conn));
  try {
    await api.post(url, { sql: `REFRESH MATERIALIZED VIEW ${qualifiedName(o, conn.type)}` });
    toast.success(`Refreshed ${o.name}`);
  } catch (e) {
    toast.error(`Could not refresh ${o.name}: ${(e as Error).message}`);
  }
}

export function objectMenu(conn: TreeConnection, ref: DbRef, o: DbObject, a: ObjectMenuActions): MenuEntry[] {
  const opensData = o.kind === "table" || o.kind === "view" || o.kind === "matview";
  const call = callTemplate(o, conn.type);
  const place = treePlace(conn, ref);
  const go = (open: () => void) => () => { open(); a.navigated(); };
  return tidyMenu([
    opensData && { kind: "item", label: "Open data", icon: Table, onSelect: go(() => openTableTab(place, o)) },
    opensData && { kind: "item", label: "Open structure", icon: FolderTree, onSelect: go(() => openStructureTab(place, o)) },
    { kind: "item", label: o.kind === "table" ? "Show CREATE SQL" : "Show SQL", icon: Code, onSelect: go(() => openSqlTab(place, o)) },
    opensData && { kind: "item", label: "New query", icon: FileCode, onSelect: go(() => openQueryTab(place, selectTemplate(o, conn.type))) },
    call ? { kind: "item", label: "New query", icon: FileCode, onSelect: go(() => openQueryTab(place, call)) } : null,
    { kind: "separator" },
    ...(o.kind === "table" && changesStructure(conn, a) ? tableStructureEntries(conn, ref, o) : []),
    { kind: "separator" },
    a.impExp && opensData && { kind: "item", label: "Export advanced...", icon: ArrowRightFromLine, onSelect: go(() => openTreeExport(conn, ref, o)) },
    a.impExp && o.kind === "table" && conn.readonly !== 1 && { kind: "item", label: "Import", icon: Upload, onSelect: go(() => openTreeImport(conn, ref, o)) },
    { kind: "separator" },
    { kind: "item", label: "Copy name", icon: Copy, onSelect: () => void copyName(o.name) },
    { kind: "separator" },
    o.kind === "matview" && { kind: "item", label: "Refresh data", icon: RotateCw, onSelect: () => void refreshMaterializedView(conn, ref, o) },
    opensData && { kind: "item", label: "Refresh structure", icon: RefreshCw, onSelect: () => void refreshDatabase(ref) },
  ]);
}

/** A column of `table`: DBGate's Rename column and Drop column — a table's only, not a view's — and Copy name. */
export function columnMenu(conn: TreeConnection, ref: DbRef, table: DbObject | undefined, name: string, a: ObjectMenuActions): MenuEntry[] {
  const at = table?.kind === "table" && changesStructure(conn, a) ? { schema: table.schema, table: table.name, column: name } : null;
  return tidyMenu([
    at && {
      kind: "item", label: "Rename column", icon: Pencil,
      onSelect: () => askNewName({ value: name, onConfirm: (newName) => saveChange(conn, ref, { kind: "rename-column", ...at, newName }) }),
    },
    at && { kind: "item", label: "Drop column", icon: Trash2, destructive: true, onSelect: () => saveChange(conn, ref, { kind: "drop-column", ...at }) },
    { kind: "separator" },
    { kind: "item", label: "Copy name", icon: Copy, onSelect: () => void copyName(name) },
  ]);
}

/** The + menu: New table, a new query, and a CREATE template for what the engine can create. */
export function newObjectMenu(conn: TreeConnection, ref: DbRef, a: ObjectMenuActions): MenuEntry[] {
  const routine = routineTemplateKind(conn.type);
  const routineSql = createRoutineTemplate(conn.type);
  const open = (sql: string) => { openQueryTab(treePlace(conn, ref), sql); a.navigated(); };
  return tidyMenu([
    changesStructure(conn, a) && { kind: "item", label: "New table", icon: Table, onSelect: () => { openNewTable(conn, ref); a.navigated(); } },
    { kind: "item", label: "New query", icon: FileCode, onSelect: () => open("") },
    { kind: "separator" },
    { kind: "item", label: "CREATE VIEW template", onSelect: () => open(createViewTemplate(conn.type)) },
    routine && routineSql ? {
      kind: "item", label: routine === "function" ? "CREATE FUNCTION template" : "CREATE PROCEDURE template", onSelect: () => open(routineSql),
    } : null,
    { kind: "item", label: "CREATE TRIGGER template", onSelect: () => open(createTriggerTemplate(conn.type)) },
  ]);
}

/** ⋮: the structure read again, the connection opened again, closed, and the tree folded up. */
export function moreMenu(conn: TreeConnection, ref: DbRef): MenuEntry[] {
  return [
    { kind: "item", label: "Refresh structure", icon: RefreshCw, onSelect: () => void refreshDatabase(ref) },
    { kind: "item", label: "Full refresh", hint: "columns too", onSelect: () => void refreshDatabase(ref, { full: true }) },
    { kind: "item", label: "Reconnect", icon: RotateCw, onSelect: () => void reconnectConnection(conn.id) },
    { kind: "item", label: "Disconnect", icon: Power, onSelect: () => void disconnectConnection(conn.id) },
    { kind: "separator" },
    { kind: "item", label: "Collapse all", icon: ChevronsDownUp, onSelect: collapseAllObjects },
  ];
}
