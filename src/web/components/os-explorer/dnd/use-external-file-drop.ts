/**
 * Drop target for a native OS `Files` drag — the upload counterpart to `useEntryDropTarget`
 * (PPM's own entry drags). The two never overlap: an entry drag carries `ENTRY_DRAG_MIME` but
 * never `Files` (see `use-entry-drag-source.ts`), so a caller wires both hooks' handlers onto
 * the same element — see `usePathDropTarget` — and whichever drag kind is actually happening
 * is the only one that ever calls `preventDefault`.
 *
 * `isExternalFileDrag` is the project tree's own check (`use-tree-row-dnd.ts`), reused rather
 * than redeclared: it excludes the tree's legacy single-path MIME, which an entry drag never
 * carries either, so the same test is exactly as correct here.
 */

import { useCallback, useRef, useState, type DragEvent } from "react";
import { isExternalFileDrag } from "@/components/explorer/use-tree-row-dnd";
import { collectDroppedEntries, type DroppedEntry } from "../upload/collect-dropped-entries";
import type { EntryDropTargetResult } from "./use-entry-drop-target";

export interface ExternalFileDropOptions {
  /** Directory a drop uploads into; null disables the target. */
  targetDir: string | null;
  onFiles(entries: DroppedEntry[], targetDir: string): void;
  disabled?: boolean;
}

export function useExternalFileDrop(options: ExternalFileDropOptions): EntryDropTargetResult {
  const { targetDir, onFiles, disabled } = options;
  const [isOver, setIsOver] = useState(false);
  // Nested children fire their own enter/leave pairs; only a balanced count means "left".
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setIsOver(false);
  }, []);

  const applies = useCallback(
    (event: DragEvent) => !disabled && targetDir != null && isExternalFileDrag(event),
    [disabled, targetDir],
  );

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (!applies(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth.current++;
      setIsOver(true);
    },
    [applies],
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (!applies(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    },
    [applies],
  );

  const onDragLeave = useCallback((event: DragEvent) => {
    if (depth.current === 0) return;
    event.stopPropagation();
    depth.current--;
    if (depth.current === 0) setIsOver(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!applies(event) || targetDir == null) return;
      event.preventDefault();
      event.stopPropagation();
      const dataTransfer = event.dataTransfer;
      reset();
      void collectDroppedEntries(dataTransfer).then((entries) => {
        if (entries.length > 0) onFiles(entries, targetDir);
      });
    },
    [applies, targetDir, onFiles, reset],
  );

  return { isOver, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
