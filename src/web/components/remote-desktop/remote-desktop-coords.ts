/**
 * Client → host coordinate mapping. Only the canvas's CSS-pixel bounding rect matters —
 * `devicePixelRatio` describes the *viewer's* screen (irrelevant to host pixels, and would
 * double-scale/misplace the cursor if folded in), so it is deliberately never read here.
 */
export interface Fraction {
  xFrac: number;
  yFrac: number;
}

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/** `rect` is the canvas element's `getBoundingClientRect()`. Fractions are clamped to 0..1 so
 *  a pointer that slips just outside the element (fast drag) still maps to an edge, not a
 *  wildly out-of-range host coordinate. */
export function fractionFromPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): Fraction {
  const xFrac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const yFrac = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  return { xFrac: clamp01(xFrac), yFrac: clamp01(yFrac) };
}

/** A CSS `transform: translate(panX, panY) scale(scale)` applied around the transformed
 *  element's own center (the mobile viewer's default `transform-origin`). */
export interface ZoomPanTransform {
  scale: number;
  panX: number;
  panY: number;
}

/**
 * Reverse-maps a screen point through an active pinch-zoom/pan transform back to a 0..1
 * fraction of the capture — used by the mobile touch viewer, which zooms/pans the canvas with
 * a CSS transform instead of re-rendering at a different resolution.
 *
 * `rect` MUST be the bounding rect of the never-transformed container the canvas fills at
 * `scale=1, pan=0` (not the live, possibly-transformed canvas rect) — that container is the
 * stable reference frame this function projects screen points back into. Deliberately pure
 * arithmetic rather than reading the live (transformed) element's `getBoundingClientRect()`:
 * jsdom does not compute CSS transforms into that rect at all, so this stays unit-testable,
 * and it avoids relying on `transform-origin` math the browser applies opaquely.
 */
export function fractionFromZoomedPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  transform: ZoomPanTransform,
): Fraction {
  const scale = transform.scale || 1;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const baseX = cx + (clientX - cx - transform.panX) / scale;
  const baseY = cy + (clientY - cy - transform.panY) / scale;
  return fractionFromPoint(baseX, baseY, rect);
}
