/**
 * Long-press on a phone task row opens its action sheet; a right-click (or the browser's own
 * long-press `contextmenu`) does the same. The press is a timer armed on `touchstart` and
 * disarmed by a move past `MOVE_TOLERANCE_PX`, by `touchend` and — the one that matters — by
 * `touchcancel`: once the browser takes the gesture for a scroll it sends that and nothing else,
 * so a timer it did not clear would open the sheet over a list the finger is already moving.
 *
 * Lifting the finger after the sheet opened is no tap. A browser whose own long-press is slower
 * than ours still makes a click of it, and that click would land on the sheet's backdrop and close
 * it, so the `touchend` is cancelled (which makes the browser skip the click). A click that still
 * reaches the row is swallowed: `swallowClick()` answers true once for it.
 */
import { useCallback, useEffect, useMemo, useRef, type MouseEvent, type TouchEvent } from "react";

export const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;

export function useTaskRowLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  /** The current touch already opened the sheet: its click is not a tap. */
  const fired = useRef(false);
  const touching = useRef(false);
  const latest = useRef(onLongPress);
  latest.current = onLongPress;

  const disarm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => disarm, [disarm]);

  const fire = useCallback(() => {
    disarm();
    if (touching.current) {
      if (fired.current) return; // the timer and the browser's own contextmenu both arrived
      fired.current = true;
    }
    latest.current();
  }, [disarm]);

  const handlers = useMemo(() => ({
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      touching.current = true;
      fired.current = false;
      origin.current = { x: t.clientX, y: t.clientY };
      disarm();
      timer.current = setTimeout(fire, LONG_PRESS_MS);
    },
    onTouchMove: (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || !origin.current) return;
      if (Math.abs(t.clientX - origin.current.x) > MOVE_TOLERANCE_PX || Math.abs(t.clientY - origin.current.y) > MOVE_TOLERANCE_PX) disarm();
    },
    onTouchEnd: (e: TouchEvent) => { disarm(); if (fired.current && e.cancelable) e.preventDefault(); },
    onTouchCancel: () => { disarm(); touching.current = false; },
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); fire(); },
  }), [disarm, fire]);

  const swallowClick = useCallback((): boolean => {
    touching.current = false;
    if (!fired.current) return false;
    fired.current = false;
    return true;
  }, []);

  return { handlers, swallowClick };
}
