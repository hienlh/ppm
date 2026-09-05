/** Shared plumbing between the window drag and resize gestures. */

import type { Bounds, Rect } from "./window-geometry";

export interface WindowGestureContext {
  /** Rect at the moment the gesture starts — read lazily so it is never stale. */
  getRect: () => Rect;
  getBounds: () => Bounds;
  /**
   * Layer scale when an ancestor applies a CSS transform/zoom. Pointer deltas are in
   * screen pixels, layout coordinates are not, so deltas must be divided by it or the
   * window drifts away from the cursor.
   */
  getScale: () => number;
  /** `committed` is true on the last frame of the gesture — the only time the store is written. */
  onChange: (rect: Rect, committed: boolean) => void;
  /** Raises the transparent capture overlay so iframes/editors cannot swallow the pointer. */
  onGestureActive: (active: boolean) => void;
  disabled?: boolean;
}

/** Gesture config shared by both hooks: keep the pointer captured, ignore taps. */
export const WINDOW_DRAG_CONFIG = {
  filterTaps: true,
  pointer: { capture: true },
} as const;

/**
 * True when a gesture event arrives with no rect to work from.
 *
 * A gesture can outlive the window it started on: pressing a caption button (close, or
 * anything that unmounts the frame) begins a drag on the titlebar, and @use-gesture still
 * delivers a terminating event afterwards — with `first` false and `memo` undefined, because
 * the frame that would have captured the rect is gone. Reading `memo.x` there is a
 * `TypeError` on every window close. Nothing is left to move or resize, so the gesture is
 * abandoned; the caller must still lower the layer's capture overlay on a `last` event.
 */
export function gestureAbandoned(first: boolean, memo: unknown): boolean {
  return !first && memo === undefined;
}

/**
 * Pointer displacement since the gesture started, corrected for layer scale.
 *
 * Derived from the raw pointer coordinates (`xy` minus `initial`) rather than the
 * recogniser's `movement`: with a tap threshold in play, `movement` has those first pixels
 * subtracted, which would leave the window trailing the pointer by the threshold for the
 * rest of the gesture. Both values are cumulative from the gesture's start, so applying
 * them to the rect captured at that moment can never drift the way per-frame deltas do.
 */
export function gestureDisplacement(
  xy: readonly [number, number],
  initial: readonly [number, number],
  scale: number,
): { dx: number; dy: number } {
  const s = scale > 0 ? scale : 1;
  return { dx: (xy[0] - initial[0]) / s, dy: (xy[1] - initial[1]) / s };
}
