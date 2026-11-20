/**
 * The one way anything outside this folder opens a file-explorer window.
 *
 * Callers (command palette, nav rail, project-tree context menu, the Assistant, a `/files` link,
 * a path in an AI answer) should not have to know about window kinds or payload keys, and
 * passing no path should land somewhere sensible rather than at a hardcoded "/" that does not
 * exist on Windows.
 */

import { useWindowStore } from "@/components/floating-window/window-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { useExplorerStore } from "./explorer-store";
import { selectWhenListed } from "./select-when-listed";
import { cachedHomedir, getHostInfo } from "./use-host-info";
import { MOBILE_EXPLORER_WINDOW_ID, openMobileExplorer } from "./use-explorer-open-state";

export interface OpenExplorerOptions {
  /** A file in `path` to select (and scroll to) once the folder is listed. */
  select?: string | null;
}

/**
 * Open an explorer at `path`, or at the host's home directory when omitted — a floating
 * window on desktop, the full-screen sheet on mobile. Returns the window id (desktop),
 * `MOBILE_EXPLORER_WINDOW_ID` (mobile), or null when the home lookup failed and no path
 * was given, or when every window slot is taken (the window store then raises its oldest
 * window, which may not be an explorer at all).
 */
export async function openExplorer(path?: string, opts: OpenExplorerOptions = {}): Promise<string | null> {
  if (isMobileDevice()) {
    await openMobileExplorer(path);
    if (opts.select) selectWhenListed(MOBILE_EXPLORER_WINDOW_ID, opts.select);
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
  const windows = useWindowStore.getState();
  const id = windows.open("explorer", { path: target });
  const opened = useWindowStore.getState().windows[id];
  if (opened?.kind !== "explorer" || (opened.payload as { path?: unknown } | undefined)?.path !== target) return null;
  if (opts.select) {
    // The window's body creates its slice on mount; creating it here first is the same call
    // (`ensure` keeps an existing slice), so the selection is in place before the first listing.
    useExplorerStore.getState().ensure(id, target);
    selectWhenListed(id, opts.select);
  }
  return id;
}
