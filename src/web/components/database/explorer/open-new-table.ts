/**
 * DBGate's New table, from wherever it is asked for: a database's menu and its Tables "+" in the
 * tree, the empty database's button, the command palette. Never on a connection that refuses
 * writes, whose callers leave the entry out.
 */
import { useSettingsStore } from "@/stores/settings-store";
import { currentDatabase, useDbExplorer } from "./db-explorer-store";
import { dbKey, hasSchemaChoice, initialSchema, schemaOptions, type DbRef, type TreeConnection } from "./explorer-model";
import { openNewTableTab, treePlace } from "./open-db-tabs";

/** The schema a new table goes in: the one the tree shows for `ref` (Postgres), `public` until it has read them. */
export function newTableSchema(conn: Pick<TreeConnection, "type">, ref: DbRef): string | null {
  if (!hasSchemaChoice(conn.type)) return null;
  const key = dbKey(ref);
  const remembered = useSettingsStore.getState().dbExplorerView.schemas[key];
  const list = useDbExplorer.getState().objects[key];
  if (list?.state !== "ready") return remembered ?? "public";
  return initialSchema(schemaOptions(list.data), remembered) ?? "public";
}

export function openNewTable(conn: TreeConnection, ref: DbRef): string {
  return openNewTableTab(treePlace(conn, ref), newTableSchema(conn, ref));
}

/** The connection of the database the sidebar shows, when New table can be offered on it. */
export function newTableConnection(): TreeConnection | null {
  const current = currentDatabase();
  const conn = current ? useDbExplorer.getState().connections.find((c) => c.id === current.conn) : undefined;
  return conn && conn.readonly !== 1 ? conn : null;
}

/** From the palette: on the database the sidebar shows. */
export function openNewTableOnCurrentDatabase(): void {
  const current = currentDatabase();
  const conn = newTableConnection();
  if (current && conn) openNewTable(conn, current);
}
