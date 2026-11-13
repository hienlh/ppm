import { clampRect, MIN_SIZE, type Bounds, type Rect } from "@/components/floating-window/window-geometry";

/** Space left between the anchor window and the one placed beside it. */
const GAP = 12;
/** Distance from the layer's right edge for a window with nothing to stand beside. */
const EDGE_MARGIN = 16;
/** A chat column: wide enough for code blocks, narrow enough to leave the anchor in view. */
const PREFERRED_WIDTH = 480;
const WIDTH_SHARE = 0.36;
/**
 * How far below the anchor's top an overlapping window starts, so the anchor's titlebar —
 * its minimise and close buttons — stays reachable when there is no room beside it.
 */
const TITLEBAR_CLEARANCE = 40;

/**
 * Where a window opened from another one goes: to the anchor's right when that fits, else to
 * its left, else over the anchor's right edge, a titlebar lower. A side with at least the
 * minimum width is used at that narrower width before the anchor is covered. Without an
 * anchor (the calling panel is a tab, or minimised) it stands at the layer's right edge.
 */
export function besideWindowRect(anchor: Rect | null, bounds: Bounds): Rect {
  const w = Math.max(MIN_SIZE.w, Math.min(PREFERRED_WIDTH, Math.round(bounds.w * WIDTH_SHARE)));
  if (!anchor) {
    const y = EDGE_MARGIN * 3;
    return clampRect({ x: bounds.w - EDGE_MARGIN - w, y, w, h: bounds.h - y - EDGE_MARGIN * 3 }, bounds);
  }
  const { y, h } = anchor;
  const rightX = anchor.x + anchor.w + GAP;
  const rightSpace = bounds.w - rightX;
  if (rightSpace >= MIN_SIZE.w) return clampRect({ x: rightX, y, w: Math.min(w, rightSpace), h }, bounds);
  const leftSpace = anchor.x - GAP;
  if (leftSpace >= MIN_SIZE.w) {
    const width = Math.min(w, leftSpace);
    return clampRect({ x: anchor.x - GAP - width, y, w: width, h }, bounds);
  }
  const overY = anchor.y + TITLEBAR_CLEARANCE;
  return clampRect({ x: bounds.w - EDGE_MARGIN - w, y: overY, w, h: Math.min(h, bounds.h - overY) }, bounds);
}
