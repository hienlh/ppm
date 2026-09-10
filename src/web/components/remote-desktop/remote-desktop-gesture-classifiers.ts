/**
 * Pure classifiers the mobile touch viewer's gesture engine uses to tell "tap" apart from
 * "drag", and "pinch-zoom" apart from "two-finger scroll". Kept dependency-free (no DOM,
 * no React) so they can be unit-tested without a browser.
 */

/** One sampled point in a gesture: client-space coordinates + a timestamp (ms, any monotonic
 *  clock — `performance.now()` in the real hook). */
export interface PointerSample {
  x: number;
  y: number;
  t: number;
}

/** A tap is a touch that ends close to where it started, quickly — anything else (moved
 *  further, or held longer) is a drag/long-press instead. Both thresholds must pass; a fast
 *  but far swipe is a drag, and a slow-but-still finger is a long-press, not a tap. */
export function isTapGesture(
  start: PointerSample,
  end: PointerSample,
  moveThresholdPx = 10,
  maxDurationMs = 300,
): boolean {
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const duration = end.t - start.t;
  return dist <= moveThresholdPx && duration <= maxDurationMs;
}

export type TwoFingerGesture = "pinch" | "scroll";

/**
 * Two-finger gestures start ambiguous — pinch-zoom and two-finger-scroll both begin as "two
 * fingers moved a little". They are told apart by which signal crosses its threshold first:
 * the distance *between* the fingers changing (pinch) vs. their midpoint translating while
 * staying roughly the same distance apart (scroll). Once a gesture is classified, the caller
 * should keep calling this with the *same* `startDistance` for the rest of the gesture and
 * lock in the first non-null-equivalent result — see `use-remote-desktop-touch.ts`.
 */
export function classifyTwoFingerGesture(
  startDistance: number,
  currentDistance: number,
  distanceThresholdPx = 15,
): TwoFingerGesture {
  return Math.abs(currentDistance - startDistance) > distanceThresholdPx ? "pinch" : "scroll";
}

/** Euclidean distance between two touch points — shared helper so the hook and its tests
 *  compute "finger spread" identically. */
export function touchDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Midpoint between two touch points. */
export function touchMidpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
