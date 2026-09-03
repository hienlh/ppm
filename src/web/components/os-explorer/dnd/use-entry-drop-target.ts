/**
 * Makes any element a drop target for an entry drag: a directory row, a view background, a
 * sidebar place, a breadcrumb crumb or a project-tree node.
 *
 * Two timers, both Finder/Explorer behaviour: the highlight only appears after the pointer
 * has stayed 120 ms (a drag that sweeps across ten rows must not flash all ten), and an
 * optional spring-load opens the hovered folder after 800 ms so a deep destination is
 * reachable without dropping first. Spring-load is opt-in because it only makes sense where
 * "open" does not destroy the drag — Column view and the project tree.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { decideDrop, type DropDecision } from "./drop-target-decision";
import { getInFlightDrag } from "./entry-drag-state";
import { decodeEntryDrag, ENTRY_DRAG_MIME, type DropOperation, type EntryDragPayload } from "./entry-drag-payload";

const HIGHLIGHT_DELAY_MS = 120;
const SPRING_LOAD_MS = 800;

export interface EntryDropTargetOptions {
  /** Directory a drop writes into; null disables the target (a file row, a missing path). */
  targetDir: string | null;
  onDropEntries(payload: EntryDragPayload, op: DropOperation, targetDir: string): void;
  /** Opens the hovered folder after a rest — Column view and the project tree only. */
  springLoad?: () => void;
  disabled?: boolean;
}

export interface EntryDropTargetResult {
  /** True once the pointer has rested long enough for the target to claim the drop. */
  isOver: boolean;
  handlers: {
    onDragEnter(event: DragEvent): void;
    onDragOver(event: DragEvent): void;
    onDragLeave(event: DragEvent): void;
    onDrop(event: DragEvent): void;
  };
}

function decisionFor(event: DragEvent, targetDir: string | null, payload: EntryDragPayload | null): DropDecision {
  return decideDrop({
    types: Array.from(event.dataTransfer.types),
    payload,
    targetDir,
    modifiers: { ctrlKey: event.ctrlKey, altKey: event.altKey },
  });
}

export function useEntryDropTarget(options: EntryDropTargetOptions): EntryDropTargetResult {
  const { targetDir, onDropEntries, springLoad, disabled } = options;
  const [isOver, setIsOver] = useState(false);
  // Nested children fire their own enter/leave pairs; only a balanced count means "left".
  const depth = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const stopTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  const reset = useCallback(() => {
    depth.current = 0;
    stopTimers();
    setIsOver(false);
  }, [stopTimers]);

  useEffect(() => stopTimers, [stopTimers]);

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (disabled) return;
      if (!decisionFor(event, targetDir, getInFlightDrag()).accept) return;
      event.preventDefault();
      event.stopPropagation();
      depth.current++;
      if (depth.current > 1) return;
      timers.current.push(setTimeout(() => setIsOver(true), HIGHLIGHT_DELAY_MS));
      if (springLoad) timers.current.push(setTimeout(springLoad, SPRING_LOAD_MS));
    },
    [disabled, targetDir, springLoad],
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (disabled) return;
      const decision = decisionFor(event, targetDir, getInFlightDrag());
      if (!decision.accept) return;
      // Claiming the drop here is what keeps a directory row from also handing the drop to
      // the view background behind it.
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = decision.op === "copy" ? "copy" : "move";
    },
    [disabled, targetDir],
  );

  const onDragLeave = useCallback(
    (event: DragEvent) => {
      if (depth.current === 0) return;
      event.stopPropagation();
      depth.current--;
      if (depth.current === 0) {
        stopTimers();
        setIsOver(false);
      }
    },
    [stopTimers],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (disabled) return;
      // The real payload is readable now; the module ref is only the hover-time stand-in.
      const payload = decodeEntryDrag(event.dataTransfer.getData(ENTRY_DRAG_MIME)) ?? getInFlightDrag();
      const decision = decisionFor(event, targetDir, payload);
      if (!decision.accept) {
        // A rejected PPM drag is still consumed here, so the browser does not fall back to
        // navigating to the dropped path; a foreign drag is left alone entirely.
        if (decision.reason !== "not-an-entry-drag") {
          event.preventDefault();
          event.stopPropagation();
        }
        reset();
        return;
      }
      if (!payload || targetDir == null) {
        reset();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      reset();
      onDropEntries(payload, decision.op, targetDir);
    },
    [disabled, targetDir, onDropEntries, reset],
  );

  return { isOver, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
