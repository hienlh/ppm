/**
 * Opens DBGate's Import/Export tab on a form filled in from where it was asked for (see
 * `gridExportForm`, `databaseExportForm`, `importIntoForm`). Every opening is a tab of its own, as
 * in DBGate; a database file's goes with the file's project, everything else to every workspace.
 */
import { useTabStore } from "@/stores/tab-store";
import { randomId } from "@/lib/utils";
import type { DbObject } from "../../../../shared/db-structure";
import { connectionById, currentDatabase } from "../explorer/db-explorer-store";
import type { DbRef, TreeConnection } from "../explorer/explorer-model";
import { treePlace } from "../explorer/open-db-tabs";
import { databaseExportForm, impExpTitle, importIntoForm, type ImpExpDatabase, type ImpExpForm } from "./impexp-state";

export function openImpExpTab(form: ImpExpForm, databaseName?: string | null): string {
  const target = form.db.target;
  return useTabStore.getState().openTab({
    type: "db-impexp",
    title: impExpTitle(form, databaseName),
    projectId: target?.kind === "file" ? target.projectName ?? null : null,
    closable: true,
    metadata: { impexpId: randomId(), impexp: form },
  });
}

/** `ref`'s database as the tree names it; the schema an object of it lives in, when there is one. */
function treeDatabase(conn: TreeConnection, ref: DbRef, object?: DbObject): ImpExpDatabase {
  return { target: treePlace(conn, ref).target, schema: object?.schema ?? null };
}

/** The tree's Export on a database, and Export advanced... on one of its tables or views. */
export function openTreeExport(conn: TreeConnection, ref: DbRef, object?: DbObject): void {
  openImpExpTab(databaseExportForm(treeDatabase(conn, ref, object), object ? [object.name] : []), ref.database ?? conn.name);
}

/**
 * The tree's Import on a database, or into one of its tables: files to the database, which the
 * first file added is read into when a table was named. Never into a connection that refuses writes.
 */
export function openTreeImport(conn: TreeConnection, ref: DbRef, table?: DbObject): void {
  if (conn.readonly === 1) return;
  openImpExpTab(importIntoForm(treeDatabase(conn, ref, table), table?.name), ref.database ?? conn.name);
}

/** The palette's Export database: the database the sidebar shows, or none to choose yet. */
export function openExportOfCurrentDatabase(): void {
  const current = currentDatabase();
  const conn = current ? connectionById(current.conn) : undefined;
  if (current && conn) openTreeExport(conn, current);
  else openImpExpTab(databaseExportForm({ target: null, schema: null }));
}

/** The palette's Import data: into the database the sidebar shows, unless it refuses writes. */
export function openImportIntoCurrentDatabase(): void {
  const current = currentDatabase();
  const conn = current ? connectionById(current.conn) : undefined;
  if (current && conn && conn.readonly !== 1) openTreeImport(conn, current);
  else openImpExpTab(importIntoForm({ target: null, schema: null }));
}
