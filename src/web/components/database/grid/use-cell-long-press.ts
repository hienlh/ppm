/**
 * A phone's way into the cell menu: a press held on a cell. Glide has a long touch of its own, but
 * it reports one only once the finger lifts, and as a menu only on the cell its cursor is on; this
 * one opens under the finger, as a phone's menus do, on whichever cell it is held on.
 *
 * Three ways a press goes wrong, each silently:
 * - the browser takes the gesture for a scroll: it sends `touchcancel`, then no `touchmove` or
 *   `touchend` at all — a timer still armed would fire into the scroll;
 * - the finger lifting after the menu opened: Glide reads that `touchend` as a tap (a long one
 *   stretches the selection from its cursor, a short one selects the cell alone), so the menu would
 *   act on another selection than the one it opened for, and the click a browser makes of it lands
 *   on the sheet's backdrop, which closes the sheet. That one `touchend` is stopped before anything
 *   sees it, which also cancels the click; a click that comes anyway is swallowed;
 * - the click never coming: what swallows it goes with the next touch, so that touch still works.
 */
import { useCallback, useEffect, useRef, type TouchEvent } from "react";
import type { Item } from "@glideapps/glide-data-grid";

/** Under Glide's own 500 ms, so the menu is open before Glide would call the touch long. */
export const LONG_PRESS_MS = 450;
/** Finger travel that makes a press a scroll. */
export const MOVE_TOLERANCE_PX = 8;

export interface CellPoint { x: number; y: number }

/**
 * `cellAt` finds the cell under a point (null where there is none: the header, the row numbers);
 * `onPress` opens the menu on it. Both are read when the press fires, never kept from an earlier render.
 */
export function useCellLongPress(
  enabled: boolean,
  cellAt: (point: CellPoint, target: EventTarget | null) => Item | null,
  onPress: (cell: Item, point: CellPoint) => void,
) {
  const latest = useRef({ cellAt, onPress });
  latest.current = { cellAt, onPress };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef<{ point: CellPoint; target: EventTarget | null } | null>(null);
  const unswallow = useRef<(() => void) | null>(null);
  /** Where the finger now down came down, and whether it has since scrolled rather than tapped. */
  const down = useRef<{ point: CellPoint; travelled: boolean } | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pressed.current = null;
  }, []);

  /** Stops the lift that ends a press which opened the menu, and the click a browser makes of it. */
  const swallowLift = useCallback(() => {
    unswallow.current?.();
    const stop = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const lift = (e: Event) => {
      stop(e);
      window.removeEventListener("touchend", lift, true);
    };
    const click = (e: Event) => {
      stop(e);
      done();
    };
    const done = () => {
      window.removeEventListener("touchend", lift, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("touchstart", done, true);
      window.removeEventListener("pointerdown", done, true);
      unswallow.current = null;
    };
    // On the window, capturing: ahead of Glide's own listeners there, and of everything under it.
    window.addEventListener("touchend", lift, true);
    window.addEventListener("click", click, true);
    // The next touch is a tap of its own, whether the click came or not.
    window.addEventListener("touchstart", done, true);
    window.addEventListener("pointerdown", done, true);
    unswallow.current = done;
  }, []);

  const fire = useCallback(() => {
    const press = pressed.current;
    cancel();
    if (!press) return;
    const cell = latest.current.cellAt(press.point, press.target);
    // Nothing under the finger to open a menu on: the touch stays Glide's.
    if (!cell) return;
    swallowLift();
    latest.current.onPress(cell, press.point);
  }, [cancel, swallowLift]);

  /** The browser's own long press (Android's `contextmenu`) can come first: the menu opens then. */
  const pressNow = useCallback((): boolean => {
    if (!timer.current) return false;
    fire();
    return true;
  }, [fire]);

  const onTouchStart = useCallback((e: TouchEvent<HTMLElement>) => {
    cancel();
    const touch = e.touches[0]!;
    // A second finger is a pinch, not a press, and no tap either.
    down.current = { point: { x: touch.clientX, y: touch.clientY }, travelled: e.touches.length !== 1 };
    if (!enabled || e.touches.length !== 1) return;
    pressed.current = { point: down.current.point, target: e.target };
    timer.current = setTimeout(fire, LONG_PRESS_MS);
  }, [enabled, cancel, fire]);

  const onTouchMove = useCallback((e: TouchEvent<HTMLElement>) => {
    const from = down.current;
    const touch = e.touches[0];
    if (!from || !touch || Math.hypot(touch.clientX - from.point.x, touch.clientY - from.point.y) <= MOVE_TOLERANCE_PX) return;
    from.travelled = true;
    cancel();
  }, [cancel]);

  // The browser has taken the gesture, and sends nothing more for it.
  const onTaken = useCallback(() => {
    if (down.current) down.current.travelled = true;
    cancel();
  }, [cancel]);

  /**
   * Whether the finger last down scrolled the grid: Glide reports a tap for a scroll that stayed
   * inside one row, since it only compares the first row in view. Kept past the lift, which Glide
   * hears after this hook does.
   */
  const travelled = useCallback(() => down.current?.travelled === true, []);

  // Gone mid-press: no menu for a grid that is no longer there, and nothing left swallowing taps.
  useEffect(() => () => {
    cancel();
    unswallow.current?.();
  }, [cancel]);

  return {
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd: cancel,
      onTouchCancel: onTaken,
      onPointerCancel: onTaken,
    },
    pressNow,
    travelled,
  };
}
