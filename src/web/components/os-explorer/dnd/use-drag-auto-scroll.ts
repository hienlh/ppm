/**
 * Scrolls a container while an entry drag hovers near its edge, so a destination that is
 * off-screen is still reachable without letting go.
 *
 * Listens natively on the element rather than through React props: `dragover` bubbles from
 * whatever row the pointer is really over, and the row's own React handler stops the
 * synthetic event — which would hide every edge hover from a JSX-level handler here.
 */

import { useEffect, type RefObject } from "react";
import { ENTRY_DRAG_MIME } from "./entry-drag-payload";

/** Distance from an edge at which scrolling starts. */
const EDGE_ZONE_PX = 48;
/** Fastest scroll step per frame, reached at the very edge. */
const MAX_STEP_PX = 16;

function stepFor(distance: number): number {
  if (distance >= EDGE_ZONE_PX) return 0;
  const intensity = Math.min(1, Math.max(0, (EDGE_ZONE_PX - distance) / EDGE_ZONE_PX));
  return Math.ceil(intensity * MAX_STEP_PX);
}

export function useDragAutoScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let frame: number | null = null;
    let velocity = { x: 0, y: 0 };

    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      velocity = { x: 0, y: 0 };
    };

    const tick = () => {
      if (velocity.x === 0 && velocity.y === 0) {
        frame = null;
        return;
      }
      element.scrollBy(velocity.x, velocity.y);
      frame = requestAnimationFrame(tick);
    };

    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(ENTRY_DRAG_MIME)) return;
      const box = element.getBoundingClientRect();
      const up = stepFor(event.clientY - box.top);
      const down = stepFor(box.bottom - event.clientY);
      const left = stepFor(event.clientX - box.left);
      const right = stepFor(box.right - event.clientX);
      velocity = { x: right - left, y: down - up };
      if (frame === null && (velocity.x !== 0 || velocity.y !== 0)) frame = requestAnimationFrame(tick);
    };

    element.addEventListener("dragover", onDragOver);
    element.addEventListener("dragleave", stop);
    element.addEventListener("drop", stop);
    window.addEventListener("dragend", stop);
    return () => {
      stop();
      element.removeEventListener("dragover", onDragOver);
      element.removeEventListener("dragleave", stop);
      element.removeEventListener("drop", stop);
      window.removeEventListener("dragend", stop);
    };
  }, [ref]);
}
