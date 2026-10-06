/**
 * A new Query tab from somewhere that has no database of its own to offer, the command palette:
 * on the database the sidebar shows, else on the first saved connection — its connection box then
 * picks another. With no connection saved there is nothing to query, so the form for one opens.
 */
import { openConnectionForm } from "../open-connection-form";
import { currentDatabase, loadConnections, useDbExplorer } from "./db-explorer-store";
import { ownDatabase } from "./explorer-model";
import { openQueryTab, treePlace } from "./open-db-tabs";

export async function openNewQuery(): Promise<void> {
  if (!useDbExplorer.getState().loaded) await loadConnections();
  const { connections } = useDbExplorer.getState();
  const current = currentDatabase();
  const conn = connections.find((c) => c.id === current?.conn) ?? connections[0];
  if (!conn) {
    openConnectionForm();
    return;
  }
  const ref = current && current.conn === conn.id ? current : { conn: conn.id, database: ownDatabase(conn) };
  openQueryTab(treePlace(conn, ref), "");
}
