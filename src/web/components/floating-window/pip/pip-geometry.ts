/**
 * Size math for the PiP window request.
 *
 * Kept free of DOM reads (the screen bounds are an argument) so it is unit
 * testable and so a caller can pass a floating window rect straight through.
 */

export interface PipSize {
  width: number;
  height: number;
}

/** Below this a terminal/editor is unusable, and Chromium rejects tiny sizes. */
export const MIN_PIP_WIDTH = 320;
export const MIN_PIP_HEIGHT = 240;

/** Fallback bounds when no screen is available (SSR, tests). */
const FALLBACK_BOUNDS: PipSize = { width: 1920, height: 1080 };

function clampAxis(value: number, min: number, max: number): number {
  // Non-finite input (NaN from an unmeasured rect) collapses to the minimum
  // rather than propagating into the request.
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

/** Read the usable screen area; safe to call without a window. */
export function screenBounds(): PipSize {
  if (typeof window === "undefined" || !window.screen) return FALLBACK_BOUNDS;
  const { availWidth, availHeight } = window.screen;
  return {
    width: Number.isFinite(availWidth) && availWidth > 0 ? availWidth : FALLBACK_BOUNDS.width,
    height: Number.isFinite(availHeight) && availHeight > 0 ? availHeight : FALLBACK_BOUNDS.height,
  };
}

/**
 * Clamp a requested inner size to [min, screen] and round to whole CSS px.
 * Chromium may still ignore the hint entirely — never assume the result.
 */
export function clampPipSize(size: PipSize, bounds: PipSize = screenBounds()): PipSize {
  return {
    width: clampAxis(size.width, MIN_PIP_WIDTH, bounds.width),
    height: clampAxis(size.height, MIN_PIP_HEIGHT, bounds.height),
  };
}
