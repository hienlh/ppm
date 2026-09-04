/**
 * One-shot repair of the split between detached tabs and their floating windows.
 *
 * The two halves persist to different keys — window geometry is global and restored by
 * the window layer, panels are restored with the project — so a reload can bring back one
 * without the other. Runs once per project load, after the window layer has restored
 * (otherwise every panel would look orphaned), and unconditionally on mobile, where the
 * window layer renders nothing at all and a workspace synced from a desktop would
 * otherwise hide its detached tabs with no way to reach them.
 */
import { useEffect, useRef } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { usePanelStore } from "@/stores/panel-store";
import { persistWindowPanelChange } from "@/stores/window-panel-actions";
import { reconcileRunKey, reconcileTabHostWindows } from "@/stores/window-panel-reconcile";
import { useWindowStore } from "@/components/floating-window/window-store";

export function useWindowPanelReconcile(): void {
  const isMobile = useIsMobile();
  const currentProject = usePanelStore((s) => s.currentProject);
  const restored = useWindowStore((s) => s.restored);
  const reconciledFor = useRef<string | null>(null);

  useEffect(() => {
    if (!currentProject) return;
    if (!restored && !isMobile) return;
    const runKey = reconcileRunKey(currentProject, isMobile);
    if (reconciledFor.current === runKey) return;
    reconciledFor.current = runKey;

    const { panels, grid, focusedPanelId } = usePanelStore.getState();
    // No window layer on mobile ⇒ no window is live ⇒ every detached tab comes home.
    const liveWindowIds = isMobile
      ? []
      : Object.values(useWindowStore.getState().windows)
          .filter((w) => w.kind === "tab-host")
          .map((w) => w.id);

    const result = reconcileTabHostWindows({ panels, grid, focusedPanelId, liveWindowIds });
    if (result.changed) {
      usePanelStore.setState({ panels: result.panels, focusedPanelId: result.focusedPanelId });
      // Both halves: the window-panel blob shrank, and the tabs landed in a grid panel
      // that belongs to the active project's layout.
      persistWindowPanelChange(usePanelStore.getState);
    }
    for (const windowId of result.windowIdsToClose) useWindowStore.getState().close(windowId);
  }, [currentProject, restored, isMobile]);
}
