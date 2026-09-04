/**
 * Opening the System Monitor on whichever presentation the device has.
 *
 * `WindowLayer` renders nothing below the `md` breakpoint, so `openWindow("system-monitor")`
 * would be a silent no-op on a phone. Desktop gets the floating window; mobile gets the
 * existing `system-monitor` tab route — both host the same `SystemMonitorBody`. On
 * desktop, a second click focuses the already-open window rather than stacking a
 * duplicate — there is only one machine to monitor, so a repeat open is never a
 * distinct instance.
 */

import { useCallback } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useWindowStore } from "@/components/floating-window/window-store";
import { useTabStore } from "@/stores/tab-store";
import { resolveOpenSystemMonitorAction } from "./resolve-open-system-monitor-action";

/** Callback that opens the System Monitor the right way for this viewport. */
export function useOpenSystemMonitor(): () => void {
  const isMobile = useIsMobile();
  const openWindow = useWindowStore((s) => s.open);
  const focusWindow = useWindowStore((s) => s.focus);
  const openTab = useTabStore((s) => s.openTab);

  return useCallback(() => {
    const existing = Object.values(useWindowStore.getState().windows).find(
      (w) => w.kind === "system-monitor",
    );
    const action = resolveOpenSystemMonitorAction(isMobile, existing?.id ?? null);
    if (action.kind === "tab") openTab(action.tab);
    else if (action.kind === "focus") focusWindow(action.id);
    else openWindow("system-monitor");
  }, [isMobile, openWindow, focusWindow, openTab]);
}
