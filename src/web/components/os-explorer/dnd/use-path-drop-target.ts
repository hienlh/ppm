/**
 * Drop target for a surface that already knows its destination directory and has no drag
 * source of its own: a view background, a sidebar place, a breadcrumb crumb, the tree root.
 */

import { useCallback } from "react";
import { executeEntryDrop, type DropRunner } from "./entry-drop-executor";
import type { DropOperation, EntryDragPayload } from "./entry-drag-payload";
import { useEntryDropTarget, type EntryDropTargetResult } from "./use-entry-drop-target";

export interface PathDropTargetOptions {
  targetDir: string | null;
  run: DropRunner;
  /** Opens this destination after a rest — the project tree and Column view use it. */
  springLoad?: () => void;
  disabled?: boolean;
}

export function usePathDropTarget(options: PathDropTargetOptions): EntryDropTargetResult {
  const { targetDir, run, springLoad, disabled } = options;

  const onDropEntries = useCallback(
    (payload: EntryDragPayload, op: DropOperation, dstDir: string) => {
      void executeEntryDrop(payload, dstDir, op, run);
    },
    [run],
  );

  return useEntryDropTarget({ targetDir, onDropEntries, springLoad, disabled });
}
