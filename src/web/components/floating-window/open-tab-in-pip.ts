/**
 * Send a tab straight into picture-in-picture, without the user ever seeing a window.
 *
 * A PiP window can only adopt an element that is already in the page, and it needs somewhere
 * to put it back. The floating window is that element and that home — so one still opens
 * here, it is simply never shown: the frame keeps a pip-only window off screen, and closing
 * PiP closes it, which re-docks the tab into the panel it came from.
 */

import { usePanelStore } from "@/stores/panel-store";
import { NON_PIP_TAB_TYPES } from "@/stores/panel-utils";
import { focusPipDocument } from "./pip/pip-focus-target";
import { attachPipHost } from "./pip/pip-host";
import { TITLEBAR_HEIGHT } from "./window-chrome-contract";
import {
  clearPipOnlyWindow,
  markPipOnlyWindow,
  setWindowPip,
  whenWindowSlot,
} from "./window-pip-registry";
import { useWindowStore } from "./window-store";

export type OpenTabInPipResult = "opened" | "window-cap" | "cancelled";

/** Drop the host window; its own teardown hands the tab back to the panel it came from. */
function discard(windowId: string): void {
  clearPipOnlyWindow(windowId);
  useWindowStore.getState().close(windowId);
}

/**
 * Detach a tab into a hidden window and adopt it into a PiP window.
 *
 * Rejects when the browser refuses the request (no support, or the click's activation was
 * already spent); the caller reports that. Call it from a click handler with nothing awaited
 * before it — the one await inside is a React commit, which leaves the activation valid.
 */
export async function openTabInPip(tabId: string, panelId: string): Promise<OpenTabInPipResult> {
  const tab = usePanelStore.getState().panels[panelId]?.tabs.find((t) => t.id === tabId);
  if (tab && NON_PIP_TAB_TYPES.has(tab.type)) return "cancelled";
  const windowId = usePanelStore.getState().popOutTab(tabId, panelId);
  if (!windowId) return "window-cap";
  markPipOnlyWindow(windowId);

  // The window exists in the store, but its body is created by the frame's layout effect —
  // one commit away.
  const slot = await whenWindowSlot(windowId);
  if (!slot) {
    discard(windowId);
    return "cancelled";
  }

  const rect = useWindowStore.getState().windows[windowId]?.rect;
  let handle;
  try {
    handle = await attachPipHost(slot, {
      // A zero falls through to the host's minimum size rather than a magic default.
      width: rect?.w ?? 0,
      height: rect ? rect.h - TITLEBAR_HEIGHT : 0,
      onDetach: () => {
        setWindowPip(windowId, null);
        // Closing PiP means "done with this tab out here", not "give me a window instead":
        // the tab goes back to its strip.
        discard(windowId);
      },
    });
  } catch (err) {
    discard(windowId);
    throw err;
  }

  // Null means the window went away while the request was in flight; the host already
  // restored what it had and called onDetach.
  if (!handle) return "cancelled";

  setWindowPip(windowId, handle);
  // A DOM move carries no focus with it: without this the tab is visible in PiP but swallows
  // nothing until the user clicks it.
  focusPipDocument(handle.pipWindow.document);
  return "opened";
}
