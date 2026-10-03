/**
 * Bringing a connection into view in the Database sidebar from somewhere else — the connection
 * tab, once it has saved.
 *
 * The sidebar keeps its own list of connections, so it is told the list changed; and it may not
 * even be mounted (another sidebar section showing, or a phone with the drawer shut), so what it
 * should reveal is kept in a store it reads when it renders, rather than sent as an event it
 * would miss.
 */
import { create } from "zustand";
import { useSettingsStore } from "@/stores/settings-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";

/** Window event: the saved connections changed. `detail` is `DbConnectionsChangedDetail`. */
export const DB_CONNECTIONS_CHANGED = "ppm:db-connections-changed";

export interface DbConnectionsChangedDetail {
  connectionId?: number;
  /** Read its tables again: what they come from may have changed. */
  refreshTables?: boolean;
}

/** Window event the app answers by opening the phone's navigation drawer on `detail.tab`. */
export const OPEN_NAVIGATION = "ppm:open-navigation";

interface RevealState {
  /** The connection the tree should scroll to and flash, until it has. */
  revealId: number | null;
  /**
   * The connection the tab just connected, which the tree opens — its database made current, or
   * its database list shown — once its own list holds it: a connection saved a moment ago is not
   * in that list until it has been read again.
   */
  expandId: number | null;
  clear: (id: number) => void;
}

export const useDbSidebarReveal = create<RevealState>((set, get) => ({
  revealId: null,
  expandId: null,
  clear: (id) => { if (get().revealId === id) set({ revealId: null }); },
}));

export function announceConnectionsChanged(detail: DbConnectionsChangedDetail = {}): void {
  window.dispatchEvent(new CustomEvent<DbConnectionsChangedDetail>(DB_CONNECTIONS_CHANGED, { detail }));
}

/**
 * Shows a saved connection in the tree: its folder open, the connection opened when it was just
 * connected, the Database section on screen — the drawer on a phone — and the row flashed.
 */
export function revealConnection(conn: { id: number; group_name: string | null }, options: { expand: boolean; refreshTables: boolean }): void {
  const settings = useSettingsStore.getState();
  const tree = settings.dbExplorer;
  const folder = conn.group_name;
  if (folder && tree.collapsedFolders.includes(folder)) {
    settings.setDbExplorer({ ...tree, collapsedFolders: tree.collapsedFolders.filter((f) => f !== folder) });
  }

  if (settings.sidebarActiveTab !== "database") settings.setSidebarActiveTab("database");
  if (isMobileDevice()) window.dispatchEvent(new CustomEvent(OPEN_NAVIGATION, { detail: { tab: "database" } }));
  else if (settings.sidebarCollapsed) settings.toggleSidebar();

  useDbSidebarReveal.setState(options.expand ? { revealId: conn.id, expandId: conn.id } : { revealId: conn.id });
  announceConnectionsChanged({ connectionId: conn.id, refreshTables: options.refreshTables });
}
