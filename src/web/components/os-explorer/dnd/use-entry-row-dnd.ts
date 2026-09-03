/**
 * Drag source + drop target for one entry row/tile, collapsed into a single spreadable prop
 * bag.
 *
 * The row components sit under a Radix `ContextMenuTrigger asChild`, which clones them and
 * merges its own `ref` and `onContextMenu`. Adding seven more handlers to those signatures
 * would make an easy place to drop one of the two by accident, so the wiring stays one
 * object the row spreads verbatim.
 */

import { useMemo, type DragEvent } from "react";
import type { FsEntry } from "@/lib/fs-api";
import type { DropRunner } from "./entry-drop-executor";
import type { EntryDragOrigin } from "./entry-drag-payload";
import { useEntryDragSource } from "./use-entry-drag-source";
import { usePathDropTarget } from "./use-path-drop-target";

export interface EntryRowDndProps {
  draggable?: true;
  onDragStart?(event: DragEvent): void;
  onDragEnd?(event: DragEvent): void;
  onDragEnter(event: DragEvent): void;
  onDragOver(event: DragEvent): void;
  onDragLeave(event: DragEvent): void;
  onDrop(event: DragEvent): void;
}

export interface EntryRowDndOptions {
  entry: FsEntry;
  /** Absolute paths the drag carries — the whole selection when this row is part of it. */
  dragPaths: string[];
  run: DropRunner;
  /** Column view and the tree open the hovered folder after a rest; List/Icons do not. */
  springLoad?: () => void;
  origin?: EntryDragOrigin;
  projectName?: string;
  extraData?: Record<string, string>;
  onDragStarted?(): void;
}

export interface EntryRowDnd {
  props: EntryRowDndProps;
  /** True while this row is the claimed drop destination — draw the ring from it. */
  isDropTarget: boolean;
}

export function useEntryRowDnd(options: EntryRowDndOptions): EntryRowDnd {
  const { entry, dragPaths, run, springLoad, origin = "explorer", projectName, extraData, onDragStarted } = options;

  const source = useEntryDragSource({ paths: dragPaths, origin, projectName, extraData, onDragStarted });

  // Only a directory can receive a drop; a file row lets the event fall through to the view
  // background, which is the same folder the file lives in — exactly what the OS does.
  const target = usePathDropTarget({
    targetDir: entry.type === "directory" ? entry.path : null,
    run,
    springLoad: entry.type === "directory" ? springLoad : undefined,
  });

  const props = useMemo<EntryRowDndProps>(
    () => ({ ...source, ...target.handlers }),
    [source, target.handlers],
  );

  return { props, isDropTarget: target.isOver };
}
