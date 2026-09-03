/**
 * Drop target for a surface that already knows its destination directory and has no drag
 * source of its own: a view background, a sidebar place, a breadcrumb crumb, the tree root.
 *
 * When `onFiles` is supplied this also accepts a native OS `Files` drag on the same element —
 * the drag-to-upload entry point. The two hooks underneath are mutually exclusive by MIME
 * type (see `use-external-file-drop.ts`), so merging their handlers is safe: whichever drag
 * kind is actually happening is the only one that ever calls `preventDefault`.
 */

import { useCallback, type DragEvent } from "react";
import { executeEntryDrop, type DropRunner } from "./entry-drop-executor";
import type { DropOperation, EntryDragPayload } from "./entry-drag-payload";
import { useEntryDropTarget, type EntryDropTargetResult } from "./use-entry-drop-target";
import { useExternalFileDrop } from "./use-external-file-drop";
import type { DroppedEntry } from "../upload/collect-dropped-entries";

export interface PathDropTargetOptions {
  targetDir: string | null;
  run: DropRunner;
  /** Opens this destination after a rest — the project tree and Column view use it. */
  springLoad?: () => void;
  disabled?: boolean;
  /** Also accept a native OS file drag on this same target. Omitted where the caller has no
   *  upload destination context to hand the dropped files to. */
  onFiles?: (entries: DroppedEntry[], targetDir: string) => void;
}

function noopFiles(): void {}

export function usePathDropTarget(options: PathDropTargetOptions): EntryDropTargetResult {
  const { targetDir, run, springLoad, disabled, onFiles } = options;

  const onDropEntries = useCallback(
    (payload: EntryDragPayload, op: DropOperation, dstDir: string) => {
      void executeEntryDrop(payload, dstDir, op, run);
    },
    [run],
  );

  const entryDrop = useEntryDropTarget({ targetDir, onDropEntries, springLoad, disabled });
  // Always called (Rules of Hooks) — `disabled` is what actually turns it off when the
  // caller has no upload destination for this target.
  const fileDrop = useExternalFileDrop({
    targetDir,
    onFiles: onFiles ?? noopFiles,
    disabled: disabled || !onFiles,
  });

  if (!onFiles) return entryDrop;

  return {
    isOver: entryDrop.isOver || fileDrop.isOver,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        entryDrop.handlers.onDragEnter(event);
        fileDrop.handlers.onDragEnter(event);
      },
      onDragOver: (event: DragEvent) => {
        entryDrop.handlers.onDragOver(event);
        fileDrop.handlers.onDragOver(event);
      },
      onDragLeave: (event: DragEvent) => {
        entryDrop.handlers.onDragLeave(event);
        fileDrop.handlers.onDragLeave(event);
      },
      onDrop: (event: DragEvent) => {
        entryDrop.handlers.onDrop(event);
        fileDrop.handlers.onDrop(event);
      },
    },
  };
}
