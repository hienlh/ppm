/**
 * Makes a row, tile or tree node the source of an entry drag.
 *
 * Returns nothing at all on a coarse pointer: HTML5 drag has no touch equivalent, and the
 * guideline reserves a long press for the context menu, so a phone must not even get the
 * `draggable` attribute (it would swallow the press). Cut/Copy/Paste stays the touch path.
 */

import { useCallback, useMemo, type DragEvent } from "react";
import { setEntryDragGhost } from "./drag-ghost";
import { clearInFlightDrag, setInFlightDrag } from "./entry-drag-state";
import {
  encodeEntryDrag, ENTRY_DRAG_MIME, toFileUriList,
  type EntryDragOrigin,
} from "./entry-drag-payload";
import { usePrefersCoarsePointer } from "../use-coarse-long-press";

export interface EntryDragSourceOptions {
  /** Absolute host paths this drag carries — the whole selection when the row is selected. */
  paths: string[];
  /** Ghost labels; defaults to the basenames of `paths`. */
  names?: string[];
  origin: EntryDragOrigin;
  projectName?: string;
  /**
   * Extra `dataTransfer` entries written alongside the shared payload. The project tree
   * keeps writing its own legacy single-path type here so tree-internal drops, which have
   * their own project-scoped route, behave exactly as they did before.
   */
  extraData?: Record<string, string>;
  disabled?: boolean;
  /** Runs before the payload is written — used to make the dragged row the selected one. */
  onDragStarted?(): void;
}

export interface EntryDragSourceProps {
  draggable?: true;
  onDragStart?(event: DragEvent): void;
  onDragEnd?(event: DragEvent): void;
}

function basenameOf(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

export function useEntryDragSource(options: EntryDragSourceOptions): EntryDragSourceProps {
  const { paths, names, origin, projectName, extraData, disabled, onDragStarted } = options;
  const coarse = usePrefersCoarsePointer();
  const enabled = !coarse && !disabled && paths.length > 0;

  const handleDragStart = useCallback(
    (event: DragEvent) => {
      onDragStarted?.();
      const payload = { paths, origin, ...(projectName ? { projectName } : {}) };
      const data = event.dataTransfer;
      data.setData(ENTRY_DRAG_MIME, encodeEntryDrag(payload));
      // Accessibility / interop mirror: anything that understands dropped files sees paths.
      data.setData("text/uri-list", toFileUriList(paths));
      data.setData("text/plain", paths.join("\n"));
      for (const [type, value] of Object.entries(extraData ?? {})) data.setData(type, value);
      data.effectAllowed = "copyMove";
      setEntryDragGhost(data, names ?? paths.map(basenameOf));
      // Hover-time validation cannot read `dataTransfer`; see `entry-drag-state.ts`.
      setInFlightDrag(payload);
    },
    [paths, names, origin, projectName, extraData, onDragStarted],
  );

  return useMemo<EntryDragSourceProps>(
    () => (enabled ? { draggable: true, onDragStart: handleDragStart, onDragEnd: clearInFlightDrag } : {}),
    [enabled, handleDragStart],
  );
}
