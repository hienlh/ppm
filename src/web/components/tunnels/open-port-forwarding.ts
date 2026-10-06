/**
 * Bringing the sidebar's Port Forwarding panel on screen from elsewhere — the command palette's
 * "Forward a Port". A phone has no sidebar, so there it is the navigation drawer, opened on it.
 */
import { useSettingsStore } from "@/stores/settings-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { OPEN_NAVIGATION } from "@/components/database/db-sidebar-reveal";

export function openPortForwarding(): void {
  if (isMobileDevice()) {
    window.dispatchEvent(new CustomEvent(OPEN_NAVIGATION, { detail: { tab: "tunnels" } }));
    return;
  }
  const settings = useSettingsStore.getState();
  settings.setSidebarActiveTab("tunnels");
  if (settings.sidebarCollapsed) settings.toggleSidebar();
}
