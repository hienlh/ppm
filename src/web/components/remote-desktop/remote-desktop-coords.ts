/**
 * Client → host coordinate mapping. Only the canvas's CSS-pixel bounding rect matters —
 * `devicePixelRatio` describes the *viewer's* screen (irrelevant to host pixels, and would
 * double-scale/misplace the cursor if folded in), so it is deliberately never read here.
 */
export interface Fraction {
  xFrac: number;
  yFrac: number;
}

/** Plain bounding-box shape every function here accepts — deliberately not `DOMRect` so pure
 *  computed rects (e.g. `letterboxedContentRect`'s output) satisfy it without faking DOM-only
 *  members (`right`, `bottom`, `toJSON`, …) that nothing here ever reads. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/** `rect` is the canvas element's `getBoundingClientRect()`. Fractions are clamped to 0..1 so
 *  a pointer that slips just outside the element (fast drag) still maps to an edge, not a
 *  wildly out-of-range host coordinate. */
export function fractionFromPoint(clientX: number, clientY: number, rect: Rect): Fraction {
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
  rect: Rect,
  transform: ZoomPanTransform,
): Fraction {
  const scale = transform.scale || 1;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const baseX = cx + (clientX - cx - transform.panX) / scale;
  const baseY = cy + (clientY - cy - transform.panY) / scale;
  return fractionFromPoint(baseX, baseY, rect);
}

/**
 * The on-screen sub-rectangle a canvas actually paints its content into under `object-fit:
 * contain` (or the equivalent CSS2.1 replaced-element max-width/max-height algorithm) — the
 * canvas ELEMENT's own box does not shrink to the letterboxed video; only the pixels drawn
 * inside it do. `box` is that element's box at rest (`scale=1, pan=0` — never the live,
 * zoomed/panned rect: see `fractionFromZoomedPoint`'s doc comment for why), `contentWidth`/
 * `contentHeight` are the canvas's drawing-buffer dimensions (its `.width`/`.height`
 * attributes, i.e. the real capture resolution, NOT its CSS size).
 *
 * `object-fit: contain` centers the letterboxed content within `box` by default
 * (`object-position: 50% 50%`), so this rect's own center always coincides with `box`'s
 * center — that is what keeps `fractionFromZoomedPoint`'s transform-origin math (which derives
 * `cx,cy` from whatever rect it's given) correct when this rect is passed to it instead of the
 * raw container box.
 *
 * Falls back to `box` unchanged if the content has no size yet (e.g. before the first decoded
 * frame sets `canvas.width`/`canvas.height`).
 */
export function letterboxedContentRect(box: Rect, contentWidth: number, contentHeight: number): Rect {
  if (contentWidth <= 0 || contentHeight <= 0 || box.width <= 0 || box.height <= 0) return box;
  const boxAspect = box.width / box.height;
  const contentAspect = contentWidth / contentHeight;
  if (contentAspect > boxAspect) {
    // Content is relatively WIDER than the box -> width-constrained, letterboxed top/bottom.
    const height = box.width / contentAspect;
    return { left: box.left, top: box.top + (box.height - height) / 2, width: box.width, height };
  }
  // Content is relatively TALLER/narrower than the box -> height-constrained, letterboxed sides.
  const width = box.height * contentAspect;
  return { left: box.left + (box.width - width) / 2, top: box.top, width, height: box.height };
}
