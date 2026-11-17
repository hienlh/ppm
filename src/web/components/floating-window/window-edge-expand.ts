/**
 * Double-clicking a window's edge or corner stretches it to the edge of the layer, the way
 * macOS does: the double-clicked edge moves out to the layer's edge in its own direction and
 * the opposite edge stays where it is. A corner moves both of its edges. Holding Alt (Option
 * on a Mac) moves the opposite edge too, so the window fills the layer along that axis.
 *
 * The layer (see `window-layer.tsx`) is the same box every drag, resize and clamp already
 * works in: it stops at the nav rail, the top bar and the status bar's dock, so a window
 * stretched here never covers any of them.
 *
 * Pure — no DOM, no store — so every case is unit-testable.
 */

import { clampRect, MIN_SIZE, type Bounds, type Rect, type ResizeHandle } from "./window-geometry";

interface Span {
  start: number;
  end: number;
}

/**
 * One axis. `toStart`/`toEnd` say which of its two edges move out to the layer's edges
 * (0 and `limit`). An edge that does not move stays put, unless it lies outside the layer:
 * a window may hang off the side, but a stretched one has to fit, so that edge is pulled in.
 * When the result would be smaller than `min` (a window hanging far off the side, stretched
 * back in), the edge that moved holds and the other one gives way.
 */
function stretchSpan(span: Span, toStart: boolean, toEnd: boolean, limit: number, min: number): Span {
  if (!toStart && !toEnd) return span;
  let start = toStart ? 0 : Math.max(0, Math.min(span.start, limit));
  let end = toEnd ? limit : Math.min(limit, Math.max(span.end, 0));
  if (end - start < min) {
    if (toEnd && !toStart) start = end - min;
    else end = start + min;
  }
  return { start, end };
}

/**
 * The rect a window takes when `handle` is double-clicked. `bothSides` is the Alt/Option
 * variant. The result is passed through `clampRect`, the rule every other gesture ends with,
 * so it is always a rect the store accepts unchanged.
 */
export function expandToEdge(
  rect: Rect,
  handle: ResizeHandle,
  bounds: Bounds,
  bothSides = false,
  min: { w: number; h: number } = MIN_SIZE,
): Rect {
  const horizontal = handle.includes("e") || handle.includes("w");
  const vertical = handle.includes("n") || handle.includes("s");

  const x = stretchSpan(
    { start: rect.x, end: rect.x + rect.w },
    handle.includes("w") || (bothSides && horizontal),
    handle.includes("e") || (bothSides && horizontal),
    bounds.w,
    min.w,
  );
  const y = stretchSpan(
    { start: rect.y, end: rect.y + rect.h },
    handle.includes("n") || (bothSides && vertical),
    handle.includes("s") || (bothSides && vertical),
    bounds.h,
    min.h,
  );

  return clampRect({ x: x.start, y: y.start, w: x.end - x.start, h: y.end - y.start }, bounds);
}
