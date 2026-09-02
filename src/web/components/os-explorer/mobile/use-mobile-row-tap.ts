/**
 * Shared tap/select-mode decision for every row-level component (List, Icons — Column view
 * keeps its own simpler single-select tap, see `column-view-column.tsx`), so List and Icons
 * branch touch behavior identically instead of two near-copies of the same decision.
 *
 * Must be called from the component actually rendered *inside* the row's own
 * `<ContextMenu>` (i.e. the JSX returned inside `<ContextMenuTrigger>`, not the component
 * that renders `<ContextMenu>` itself) — that is the only position where
 * `useContext(BottomSheetCtx)` resolves to that row's own sheet state instead of the
 * default no-op value.
 */

import { useContext } from "react";
import { BottomSheetCtx } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { FsEntry } from "@/lib/fs-api";
import type { ExplorerActions } from "../actions/use-explorer-actions";
import type { EntrySelection } from "../views/use-entry-selection";
import { useMobileExplorerOpenState } from "../use-explorer-open-state";
import { mobileTapAction } from "./mobile-tap-action";

export interface MobileRowTap {
  /** True only inside the mobile sheet — desktop rows keep their existing click behavior. */
  isMobile: boolean;
  selectMode: boolean;
  /** Call from the row's onClick; returns true once it has handled the tap (mobile branch). */
  handleTap(entry: FsEntry, selected: boolean): boolean;
}

export function useMobileRowTap(actions: ExplorerActions, selection: EntrySelection): MobileRowTap {
  const isMobile = useIsMobile();
  const selectMode = useMobileExplorerOpenState((s) => s.selectMode);
  const { setOpen } = useContext(BottomSheetCtx);

  const handleTap = (entry: FsEntry, selected: boolean): boolean => {
    if (!isMobile) return false;
    if (selectMode) {
      // Toggle membership like a ctrl-click — a plain tap in Select mode never replaces
      // the whole selection with just this one row.
      selection.onRowClick(entry.path, { shiftKey: false, ctrlKey: true, metaKey: false });
      return true;
    }
    if (!selected) selection.selectOnly(entry.path);
    if (mobileTapAction(entry) === "open") actions.openEntry(entry);
    else setOpen(true); // No viewer for this file — surface the same sheet long-press would.
    return true;
  };

  return { isMobile, selectMode, handleTap };
}
