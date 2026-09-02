/**
 * View mode → component. The body renders whatever is registered for the current mode and
 * falls back to List for a mode that is not implemented yet, so a persisted preference
 * can never leave a window blank.
 *
 * Adding Icons or Column view means adding the component file and one entry here; nothing
 * else in the explorer needs to change. The toolbar offers exactly the registered modes.
 */

import type { ComponentType } from "react";
import type { FsEntry } from "@/lib/fs-api";
import type { ExplorerActions } from "../actions/use-explorer-actions";
import type { ExplorerSlice, ViewMode } from "../explorer-store";
import type { LongPressHandlers } from "../use-coarse-long-press";
import type { EntrySelection } from "./use-entry-selection";
import { ListView } from "./list-view";

export interface ExplorerViewProps {
  windowId: string;
  slice: ExplorerSlice;
  /** Already filtered and sorted — every view shares one order. */
  entries: FsEntry[];
  actions: ExplorerActions;
  selection: EntrySelection;
  /** Message from the last rejected inline commit, shown under the input. */
  inlineError: string | null;
  hasClipboard: boolean;
  isPinned(path: string): boolean;
  /** Row height in px; larger on coarse-pointer devices. */
  rowHeight: number;
  /**
   * Long-press handlers for the empty-space background menu. Must land on the same element
   * the view's background `ContextMenuTrigger` wraps — a wrapper further up the tree fires
   * the synthetic `contextmenu` event on itself, and it never bubbles down to a descendant
   * trigger.
   */
  backgroundLongPress: LongPressHandlers;
}

export const EXPLORER_VIEWS: Partial<Record<ViewMode, ComponentType<ExplorerViewProps>>> = {
  list: ListView,
};

export const AVAILABLE_VIEW_MODES = Object.keys(EXPLORER_VIEWS) as ViewMode[];

export function viewComponentFor(mode: ViewMode): ComponentType<ExplorerViewProps> {
  return EXPLORER_VIEWS[mode] ?? ListView;
}
