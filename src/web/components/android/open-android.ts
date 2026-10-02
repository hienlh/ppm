/**
 * Opens the Android tab — a tab rather than a floating window, unlike Remote Desktop.
 *
 * The difference is not cosmetic: there is exactly one host desktop to control, so a window that
 * floats over the work is right for it, while a machine can have several AVDs and a developer
 * looks at one *beside* the code they are changing. A second call focuses the tab that is
 * already open rather than stacking duplicates on the same device.
 */
import { useCallback } from "react";
import { useTabStore } from "@/stores/tab-store";

export function useOpenAndroid(): () => void {
  const openTab = useTabStore((s) => s.openTab);
  const setActiveTab = useTabStore((s) => s.setActiveTab);

  return useCallback(() => {
    const existing = useTabStore.getState().tabs.find((t) => t.type === "android");
    if (existing) { setActiveTab(existing.id); return; }
    openTab({ type: "android", title: "Android", projectId: null, closable: true });
  }, [openTab, setActiveTab]);
}
