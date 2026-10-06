/**
 * Opens the connection tab — empty for a new connection, filled in for a saved one. Editing the
 * same connection twice brings its tab forward instead of opening a second (found by the
 * connection id in its metadata, as the tab id is not always the connection's: see below).
 */
import { useTabStore } from "@/stores/tab-store";
import type { Connection } from "./use-connections";

export function openConnectionForm(conn?: Pick<Connection, "id" | "name" | "type">): void {
  const store = useTabStore.getState();
  // A tab whose Save created the connection keeps its "new" id, so it is found by its metadata.
  const open = conn && store.tabs.find((t) => t.type === "db-connection" && t.metadata?.connectionId === conn.id);
  if (open) { store.setActiveTab(open.id); return; }
  store.openTab({
    type: "db-connection",
    title: conn ? `Edit ${conn.name}` : "New connection",
    projectId: null,
    closable: true,
    metadata: conn ? { connectionId: conn.id, connectionName: conn.name, dbType: conn.type } : {},
  });
}
