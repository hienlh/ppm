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

/** Opens the System Monitor the right way for a phone-sized (`isMobile`) or wider viewport. */
export function openSystemMonitor(isMobile: boolean): void {
  const windows = useWindowStore.getState();
  const existing = Object.values(windows.windows).find((w) => w.kind === "system-monitor");
  const action = resolveOpenSystemMonitorAction(isMobile, existing?.id ?? null);
  if (action.kind === "tab") useTabStore.getState().openTab(action.tab);
  else if (action.kind === "focus") windows.focus(action.id);
  else windows.open("system-monitor");
}

/** Callback that opens the System Monitor the right way for this viewport. */
export function useOpenSystemMonitor(): () => void {
  const isMobile = useIsMobile();
  return useCallback(() => openSystemMonitor(isMobile), [isMobile]);
}
