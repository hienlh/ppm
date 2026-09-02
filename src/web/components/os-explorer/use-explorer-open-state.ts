/**
 * Global open/close state for the single mobile explorer sheet, plus its one UI-only mode
 * flag ("Select").
 *
 * Desktop windows are many and multiplex through `useWindowStore`; the mobile sheet is
 * always exactly one instance (`windowId = MOBILE_EXPLORER_WINDOW_ID`), so a tiny dedicated
 * store is simpler than threading a "mobile" window kind through the desktop window model.
 */

import { create } from "zustand";
import { useExplorerStore } from "./explorer-store";
import { cachedHomedir, getHostInfo } from "./use-host-info";

/** The one explorer-store slice id the mobile sheet ever uses. */
export const MOBILE_EXPLORER_WINDOW_ID = "mobile";

interface MobileExplorerOpenState {
  isOpen: boolean;
  /** "Select" toolbar mode: rows show checkboxes and a tap toggles selection instead of opening. */
  selectMode: boolean;
  close(): void;
  setSelectMode(value: boolean): void;
}

export const useMobileExplorerOpenState = create<MobileExplorerOpenState>((set) => ({
  isOpen: false,
  selectMode: false,
  close: () => set({ isOpen: false, selectMode: false }),
  setSelectMode: (value) => set({ selectMode: value }),
}));

/**
 * Open the mobile sheet, landing on `path`. With no path: an already-open-before instance
 * resumes wherever it was (the slice survives a close, since only `isOpen` is reset), and a
 * first-ever open falls back to the host home directory — same resolution order as the
 * desktop facade.
 */
export async function openMobileExplorer(path?: string): Promise<void> {
  const store = useExplorerStore.getState();
  const existing = store.slices[MOBILE_EXPLORER_WINDOW_ID];
  let target = path ?? existing?.path ?? cachedHomedir();
  if (!target) {
    try {
      target = (await getHostInfo()).homedir;
    } catch {
      return; // No usable starting directory — nothing sensible to open.
    }
  }

  if (!existing) {
    store.ensure(MOBILE_EXPLORER_WINDOW_ID, target);
  } else if (path && existing.path !== path) {
    // Jump an already-open instance to a new path, mirroring what `nav.go` does for a
    // window: fresh history, cleared selection — this is a new place, not a back/forward step.
    store.patch(MOBILE_EXPLORER_WINDOW_ID, {
      path: target,
      history: [target],
      historyIndex: 0,
      selection: new Set(),
      anchor: null,
      filter: "",
      inlineEdit: null,
    });
  }

  useMobileExplorerOpenState.setState({ isOpen: true, selectMode: false });
}
