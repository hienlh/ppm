/**
 * What the Connections section's menus offer, per row, in DBGate's order. The section decides
 * which row a menu is for; these only say what can be done to it.
 */
import { ArrowLeftRight, ArrowRightFromLine, Copy, FileCode, Pencil, Plug, Power, RefreshCw, Table, Trash2, Upload } from "@/lib/icons";
import { tidyMenu, type MenuEntry } from "../explorer/explorer-menu";
import {
  connectConnection, currentDatabase, disconnectConnection, duplicateConnection, refreshConnection, refreshDatabase,
  setConnectionReadonly, setCurrentDatabase,
} from "../explorer/db-explorer-store";
import { ownDatabase, singleDbRef, type DbRef, type TreeConnection } from "../explorer/explorer-model";
import { openQueryTab, treePlace } from "../explorer/open-db-tabs";
import { openNewTable } from "../explorer/open-new-table";
import type { ConnStatus } from "../explorer/db-explorer-store";
import { openTreeExport, openTreeImport } from "../impexp/open-impexp-tab";

export interface ConnectionMenuActions {
  /** Opened a tab: the phone's drawer gets out of its way. */
  navigated: () => void;
  edit: (conn: TreeConnection) => void;
  askDelete: (conn: TreeConnection) => void;
  renameFolder: (name: string) => void;
  deleteFolder: (name: string) => void;
  /** Something failed that the row does not show by itself. */
  failed: (what: string, e: unknown) => void;
  /** The device changes structure — a desktop; a phone only looks at it. */
  editsStructure: boolean;
  /** The device opens the Import/Export tab — a desktop. */
  impExp: boolean;
}

/** DBGate's New table on `ref`, where a table can be created: a desktop, a connection that takes writes. */
function newTableEntry(conn: TreeConnection, ref: DbRef, a: ConnectionMenuActions): MenuEntry | null {
  if (!a.editsStructure || conn.readonly === 1) return null;
  return { kind: "item", label: "New table", icon: Table, onSelect: () => { openNewTable(conn, ref); a.navigated(); } };
}

/** DBGate's Export and Import of a database, on a desktop; nothing is imported through a connection that refuses writes. */
function impExpEntries(conn: TreeConnection, ref: DbRef, a: ConnectionMenuActions): MenuEntry[] {
  if (!a.impExp) return [];
  return tidyMenu([
    { kind: "item", label: "Export", icon: ArrowRightFromLine, onSelect: () => { openTreeExport(conn, ref); a.navigated(); } },
    conn.readonly !== 1 && { kind: "item", label: "Import", icon: Upload, onSelect: () => { openTreeImport(conn, ref); a.navigated(); } },
  ]);
}

/** The database a connection's New query runs in: the current one when it is this connection's, else its own. */
export function queryTarget(conn: TreeConnection): DbRef {
  const single = singleDbRef(conn);
  if (single) return single;
  const current = currentDatabase();
  if (current?.conn === conn.id) return current;
  return { conn: conn.id, database: ownDatabase(conn) };
}

export function connectionMenu(conn: TreeConnection, status: ConnStatus | undefined, a: ConnectionMenuActions): MenuEntry[] {
  const open = status?.state === "open";
  const single = singleDbRef(conn);
  const connect = () => {
    if (single) void setCurrentDatabase(single);
    else void connectConnection(conn.id, { expand: true });
  };
  return tidyMenu([
    open
      ? { kind: "item", label: "Disconnect", icon: Power, onSelect: () => void disconnectConnection(conn.id) }
      : { kind: "item", label: "Connect", icon: Plug, disabled: status?.state === "connecting", onSelect: connect },
    { kind: "item", label: "New query", icon: FileCode, onSelect: () => { openQueryTab(treePlace(conn, queryTarget(conn)), ""); a.navigated(); } },
    // A connection that is one database is where its tables are made; a server's are made in one of its databases.
    single && newTableEntry(conn, single, a),
    ...(single ? impExpEntries(conn, single, a) : []),
    { kind: "item", label: "Refresh", icon: RefreshCw, disabled: !open, onSelect: () => void refreshConnection(conn.id) },
    { kind: "separator" },
    { kind: "item", label: "Edit connection…", icon: Pencil, onSelect: () => a.edit(conn) },
    { kind: "item", label: "Duplicate", icon: Copy, onSelect: () => { duplicateConnection(conn.id).catch((e) => a.failed("Could not duplicate the connection", e)); } },
    {
      kind: "check", label: "Read-only", checked: conn.readonly === 1,
      onToggle: () => { setConnectionReadonly(conn.id, conn.readonly !== 1).catch((e) => a.failed("Could not change read-only", e)); },
    },
    { kind: "separator" },
    { kind: "item", label: "Delete", icon: Trash2, destructive: true, onSelect: () => a.askDelete(conn) },
  ]);
}

export function databaseMenu(conn: TreeConnection, database: string, current: boolean, a: ConnectionMenuActions): MenuEntry[] {
  const ref: DbRef = { conn: conn.id, database };
  return tidyMenu([
    { kind: "item", label: "Switch to this database", icon: ArrowLeftRight, disabled: current, onSelect: () => void setCurrentDatabase(ref) },
    { kind: "item", label: "New query", icon: FileCode, onSelect: () => { openQueryTab(treePlace(conn, ref), ""); a.navigated(); } },
    newTableEntry(conn, ref, a),
    ...impExpEntries(conn, ref, a),
    { kind: "item", label: "Refresh structure", icon: RefreshCw, onSelect: () => void refreshDatabase(ref) },
  ]);
}

export function folderMenu(name: string, a: ConnectionMenuActions): MenuEntry[] {
  return [
    { kind: "item", label: "Rename…", icon: Pencil, onSelect: () => a.renameFolder(name) },
    { kind: "item", label: "Delete folder", icon: Trash2, hint: "keeps the connections", onSelect: () => a.deleteFolder(name) },
  ];
}
