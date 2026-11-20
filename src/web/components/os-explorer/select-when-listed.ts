/**
 * Selecting a file in an explorer that is still listing its folder.
 *
 * The selection is set at once (the list view scrolls to its anchor as soon as the row arrives),
 * then corrected against the listing: on a disk that ignores case the path asked for may differ
 * from the row's own spelling (`clip.mp4` typed, `Clip.MP4` stored), and an exact-match selection
 * would then select nothing.
 */

import { useExplorerStore } from "./explorer-store";
import { samePath } from "./host-path-parts";

/** How long to wait for the folder's listing before giving up on correcting the selection. */
const LISTING_WAIT_MS = 15_000;

export function selectWhenListed(windowId: string, file: string): void {
  const store = useExplorerStore;
  store.getState().patch(windowId, { selection: new Set([file]), anchor: file });

  // The listing on screen may still be the previous folder's until the new one starts loading,
  // so a miss counts only once a load has been seen.
  let sawLoad = false;
  const settle = (): boolean => {
    const slice = store.getState().slices[windowId];
    // Gone, moved on, or the user picked something else: nothing left to correct.
    if (!slice || slice.anchor !== file) return true;
    if (slice.loading) { sawLoad = true; return false; }
    const row = slice.entries.find((e) => samePath(e.path, file));
    if (row && row.path !== file) store.getState().patch(windowId, { selection: new Set([row.path]), anchor: row.path });
    return !!row || sawLoad;
  };
  if (settle()) return;
  const stop = store.subscribe(() => { if (settle()) { stop(); clearTimeout(timer); } });
  const timer = setTimeout(stop, LISTING_WAIT_MS);
}
