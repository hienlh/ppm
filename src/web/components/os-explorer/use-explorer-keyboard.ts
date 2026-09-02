/**
 * Keyboard behaviour for an explorer view container, shared by every view mode.
 *
 * Bound to the scrolling element rather than the window so two open explorers never both
 * react to the same key, and so PPM's global shortcuts keep working when focus is
 * elsewhere.
 */

import { useCallback } from "react";
import type { KeyboardEvent } from "react";
import type { FsEntry } from "@/lib/fs-api";
import type { ExplorerActions } from "./actions/use-explorer-actions";
import type { ExplorerSlice } from "./explorer-store";
import type { ExplorerNavigation } from "./use-explorer-navigation";
import type { EntrySelection } from "./views/use-entry-selection";

export interface ExplorerKeyboardOptions {
  /** Undefined for the one frame before the window has a slice. */
  slice: ExplorerSlice | undefined;
  /** Rows in visible order. */
  entries: FsEntry[];
  actions: ExplorerActions;
  selection: EntrySelection;
  nav: ExplorerNavigation;
}

/** Entries the keyboard acts on: the selection, or the cursor row when nothing is selected. */
export function activeEntries(slice: ExplorerSlice, entries: FsEntry[]): FsEntry[] {
  if (slice.selection.size > 0) return entries.filter((e) => slice.selection.has(e.path));
  const cursor = entries.find((e) => e.path === slice.anchor);
  return cursor ? [cursor] : [];
}

export function useExplorerKeyboard({
  slice, entries, actions, selection, nav,
}: ExplorerKeyboardOptions): (event: KeyboardEvent) => void {
  return useCallback(
    (event: KeyboardEvent) => {
      if (!slice) return;
      // The inline rename field and the filter box own their own keys.
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      const mod = event.ctrlKey || event.metaKey;
      const targets = activeEntries(slice, entries);

      if (mod) {
        switch (event.key.toLowerCase()) {
          case "a":
            event.preventDefault();
            selection.selectAll();
            return;
          case "c":
            event.preventDefault();
            actions.copy(targets);
            return;
          case "x":
            event.preventDefault();
            actions.cut(targets);
            return;
          case "v":
            event.preventDefault();
            actions.paste();
            return;
          default:
            return; // leave every other accelerator to the app
        }
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          selection.moveTo(1, event.shiftKey);
          return;
        case "ArrowUp":
          event.preventDefault();
          selection.moveTo(-1, event.shiftKey);
          return;
        case "Home":
          event.preventDefault();
          if (entries[0]) selection.selectOnly(entries[0].path);
          return;
        case "End":
          event.preventDefault();
          if (entries.length > 0) selection.selectOnly(entries[entries.length - 1]!.path);
          return;
        case "ArrowLeft":
          if (event.altKey) { event.preventDefault(); nav.back(); }
          return;
        case "ArrowRight":
          if (event.altKey) { event.preventDefault(); nav.forward(); }
          return;
        case "Backspace":
          event.preventDefault();
          nav.back();
          return;
        case "Enter":
          event.preventDefault();
          if (targets.length === 1) actions.openEntry(targets[0]!);
          return;
        case "F2":
          event.preventDefault();
          if (targets.length === 1) actions.startRename(targets[0]!);
          return;
        case "Delete":
          event.preventDefault();
          if (targets.length === 0) return;
          if (event.shiftKey) actions.confirmPermanentDelete(targets);
          else actions.trash(targets);
          return;
        case "Escape":
          selection.clear();
          return;
      }

      // Type-ahead: a single printable character with no modifier jumps to a name.
      if (event.key.length === 1 && !event.altKey) {
        event.preventDefault();
        selection.typeAhead(event.key);
      }
    },
    [slice, entries, actions, selection, nav],
  );
}
