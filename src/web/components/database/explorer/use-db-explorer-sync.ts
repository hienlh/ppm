/**
 * What keeps the Database sidebar's tree in step while it is on screen: the connection list read
 * on mount and again whenever the connections change elsewhere, the object list following the
 * active tab, and whatever waited for a driver retried once it is installed.
 */
import { useEffect } from "react";
import { useTabStore } from "@/stores/tab-store";
import { useDbDriverInstalled } from "@/hooks/use-db-driver-installed";
import { DB_CONNECTIONS_CHANGED, type DbConnectionsChangedDetail } from "../db-sidebar-reveal";
import { followActiveTab, onConnectionsChanged, retryAfterDriverInstall, startExplorer, useDbExplorer } from "./db-explorer-store";

export function useDbExplorerSync(): void {
  useEffect(() => {
    void startExplorer();
    const onChanged = (e: Event) => { void onConnectionsChanged((e as CustomEvent<DbConnectionsChangedDetail>).detail ?? {}); };
    window.addEventListener(DB_CONNECTIONS_CHANGED, onChanged);
    return () => window.removeEventListener(DB_CONNECTIONS_CHANGED, onChanged);
  }, []);

  const activeTabId = useTabStore((s) => s.activeTabId);
  const loaded = useDbExplorer((s) => s.loaded);
  useEffect(() => { followActiveTab(); }, [activeTabId, loaded]);

  useDbDriverInstalled(retryAfterDriverInstall);
}
