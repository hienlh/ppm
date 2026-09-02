/**
 * The one way anything outside this folder opens a file-explorer window.
 *
 * Callers (command palette, nav rail, project-tree context menu) should not have to know
 * about window kinds or payload keys, and passing no path should land somewhere sensible
 * rather than at a hardcoded "/" that does not exist on Windows.
 */

import { useWindowStore } from "@/components/floating-window/window-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { cachedHomedir, getHostInfo } from "./use-host-info";
import { MOBILE_EXPLORER_WINDOW_ID, openMobileExplorer } from "./use-explorer-open-state";

/**
 * Open an explorer at `path`, or at the host's home directory when omitted — a floating
 * window on desktop, the full-screen sheet on mobile. Returns the window id (desktop),
 * `MOBILE_EXPLORER_WINDOW_ID` (mobile), or null when the home lookup failed and no path
 * was given.
 */
export async function openExplorer(path?: string): Promise<string | null> {
  if (isMobileDevice()) {
    await openMobileExplorer(path);
    return MOBILE_EXPLORER_WINDOW_ID;
  }

  let target = path ?? cachedHomedir();
  if (!target) {
    try {
      target = (await getHostInfo()).homedir;
    } catch {
      return null;
    }
  }
  return useWindowStore.getState().open("explorer", { path: target });
}
