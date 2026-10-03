/**
 * Opens the connection tab — empty for a new connection, filled in for a saved one. Editing the
 * same connection twice brings its tab forward instead of opening a second (the tab id is the
 * connection's, see `deriveTabId`).
 */
import { useTabStore } from "@/stores/tab-store";
import type { Connection } from "./use-connections";

export function openConnectionForm(conn?: Pick<Connection, "id" | "name" | "type">): void {
  useTabStore.getState().openTab({
    type: "db-connection",
    title: conn ? `Edit ${conn.name}` : "New connection",
    projectId: null,
    closable: true,
    metadata: conn ? { connectionId: conn.id, connectionName: conn.name, dbType: conn.type } : {},
  });
}
