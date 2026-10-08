/**
 * The one way a user closes a window — titlebar ×, Escape on the titlebar, the dock list's ×.
 *
 * Closing a tab-host window normally hands its tab back to the grid: the user popped it out
 * and closing the window means "put it back". A window opened *as* the tab's home (a design
 * opened from the sidebar, `closeTabsOnClose` in its payload) has nowhere to go back to, so
 * closing it closes the tab. Closing the panel's last tab closes the window by itself
 * (`syncWindowPanel`), which keeps the two from ever disagreeing.
 */

import { usePanelStore } from "@/stores/panel-store";
import { windowPanelId } from "@/stores/panel-utils";
import { useWindowStore } from "./window-store";

/** Closing this window closes its tabs too, rather than handing them back to the grid. */
export function closesItsTabs(win: { kind: string; payload?: Record<string, unknown> }): boolean {
  return win.kind === "tab-host" && win.payload?.closeTabsOnClose === true;
}

export function closeWindow(id: string): void {
  const win = useWindowStore.getState().windows[id];
  if (!win) return;
  if (closesItsTabs(win)) {
    const panelId = windowPanelId(id);
    const tabs = usePanelStore.getState().panels[panelId]?.tabs ?? [];
    if (tabs.length > 0) {
      for (const tab of [...tabs]) usePanelStore.getState().closeTab(tab.id, panelId);
      return;
    }
  }
  useWindowStore.getState().close(id);
}
