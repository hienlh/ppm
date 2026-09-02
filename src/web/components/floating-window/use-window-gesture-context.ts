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

/** Scale-corrected movement for the current gesture frame. */
export function scaledMovement(
  movement: [number, number],
  scale: number,
): { dx: number; dy: number } {
  const s = scale > 0 ? scale : 1;
  return { dx: movement[0] / s, dy: movement[1] / s };
}
