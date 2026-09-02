/**
 * Long-press → context menu on touch screens that are wide enough to get the desktop
 * layout (an iPad is ≥ 768 px, so `useIsMobile` is false and the bottom-sheet path never
 * runs). Radix opens its own menu on long-press but only after 700 ms; the design rules
 * ask for 400 ms, so the press is timed here and delivered as a synthetic `contextmenu`
 * event, which is exactly what the trigger already listens for.
 *
 * Attached only when the primary pointer is coarse — a mouse keeps plain right-click.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent, type TouchEvent } from "react";

const LONG_PRESS_MS = 400;
/** Finger travel that turns a press into a scroll instead. */
const MOVE_TOLERANCE_PX = 10;

export function usePrefersCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(pointer: coarse)");
    if (!query) return;
    const update = () => setCoarse(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return coarse;
}

export interface LongPressHandlers {
  onTouchStart?(event: TouchEvent): void;
  onTouchMove?(event: TouchEvent): void;
  onTouchEnd?(event: TouchEvent): void;
  onContextMenu?(event: MouseEvent): void;
}

/**
 * Handlers to spread on a row. `onBeforeOpen` runs first so the menu acts on the pressed
 * row rather than whatever was selected before.
 */
export function useCoarseLongPress(onBeforeOpen?: () => void): LongPressHandlers {
  const coarse = usePrefersCoarsePointer();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(
    (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      const target = event.currentTarget as HTMLElement;
      origin.current = { x: touch.clientX, y: touch.clientY };
      fired.current = false;
      cancel();
      timer.current = setTimeout(() => {
        fired.current = true;
        onBeforeOpen?.();
        target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: touch.clientX,
            clientY: touch.clientY,
          }),
        );
      }, LONG_PRESS_MS);
    },
    [cancel, onBeforeOpen],
  );

  const move = useCallback(
    (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || !origin.current) return;
      const moved =
        Math.abs(touch.clientX - origin.current.x) > MOVE_TOLERANCE_PX ||
        Math.abs(touch.clientY - origin.current.y) > MOVE_TOLERANCE_PX;
      if (moved) cancel();
    },
    [cancel],
  );

  if (!coarse) return {};
  return {
    onTouchStart: start,
    onTouchMove: move,
    onTouchEnd: cancel,
  };
}
