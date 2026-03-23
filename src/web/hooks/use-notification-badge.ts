import { useEffect } from "react";
import { useNotificationStore, selectTotalUnread } from "@/stores/notification-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { setFavicon } from "@/lib/favicon";

function buildTitle(unread: number, projectName?: string, deviceName?: string): string {
  const parts = [projectName, deviceName || null, "PPM"].filter(Boolean).join(" - ");
  return unread > 0 ? `(${unread}) ${parts}` : parts;
}

/** Syncs document.title and favicon with unread notification count.
 * Uses direct Zustand subscription to update immediately even in background tabs
 * (useEffect is throttled by the browser when the tab is hidden). */
export function useNotificationBadge(): void {
  const activeProject = useProjectStore((s) => s.activeProject);
  const deviceName = useSettingsStore((s) => s.deviceName);

  useEffect(() => {
    const update = () => {
      const unread = selectTotalUnread(useNotificationStore.getState());
      document.title = buildTitle(unread, activeProject?.name, deviceName ?? undefined);
      setFavicon(unread > 0);
    };

    update(); // apply immediately on mount / when project or device name changes
    return useNotificationStore.subscribe(update); // fire on every store change
  }, [activeProject?.name, deviceName]);
}
