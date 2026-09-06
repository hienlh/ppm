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
