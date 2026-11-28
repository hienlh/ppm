/**
 * Zoomed in, the picture follows the Mouse-mode cursor so it never leaves the view — and stops
 * at the desktop's own edge instead of sliding into black.
 */
import { describe, expect, it } from "bun:test";
import { followCursor, FOLLOW_EDGE_MARGIN_PX as M } from "../../../src/web/components/remote-desktop/remote-desktop-zoom-follow";
import { fractionFromZoomedPoint } from "../../../src/web/components/remote-desktop/remote-desktop-coords";

// A 390px-wide phone, a 16:9 capture letterboxed into it.
const BOX = { left: 0, top: 0, width: 390, height: 700 };
const VIDEO = { left: 0, top: 240.3125, width: 390, height: 219.375 };

/** Where the cursor at `frac` is drawn on screen under `t`. */
function onScreen(t: { scale: number; panX: number; panY: number }, frac: { xFrac: number; yFrac: number }) {
  const cx = BOX.width / 2;
  const cy = BOX.height / 2;
  return {
    x: cx + t.panX + (VIDEO.left + frac.xFrac * VIDEO.width - cx) * t.scale,
    y: cy + t.panY + (VIDEO.top + frac.yFrac * VIDEO.height - cy) * t.scale,
  };
}

describe("zoom follows the cursor", () => {
  it("does nothing at scale 1", () => {
    const t = { scale: 1, panX: 0, panY: 0 };
    expect(followCursor(t, { xFrac: 1, yFrac: 1 }, VIDEO, BOX)).toBe(t);
  });

  it("does nothing while the cursor is comfortably inside the view", () => {
    const t = { scale: 3, panX: 0, panY: 0 };
    expect(followCursor(t, { xFrac: 0.5, yFrac: 0.5 }, VIDEO, BOX)).toBe(t);
  });

  it("slides the picture so a cursor dragged toward the right edge stays a margin inside it", () => {
    const t = { scale: 3, panX: 0, panY: 0 };
    const cursor = { xFrac: 0.72, yFrac: 0.5 };
    expect(onScreen(t, cursor).x).toBeGreaterThan(BOX.width); // off screen without the follow
    const next = followCursor(t, cursor, VIDEO, BOX);
    expect(onScreen(next, cursor).x).toBeCloseTo(BOX.width - M, 6);
    expect(next.panY).toBe(0);
    expect(next.scale).toBe(3);
    // Hit-testing agrees: the point under the cursor's new screen spot is still the cursor.
    const p = onScreen(next, cursor);
    expect(fractionFromZoomedPoint(p.x, p.y, VIDEO, next).xFrac).toBeCloseTo(0.72, 6);
  });

  it("follows upward and leftward too", () => {
    const t = { scale: 4, panX: 0, panY: 0 };
    const cursor = { xFrac: 0.2, yFrac: 0.1 };
    const next = followCursor(t, cursor, VIDEO, BOX);
    expect(onScreen(next, cursor).x).toBeCloseTo(M, 6);
    expect(onScreen(next, cursor).y).toBeCloseTo(M, 6);
    // The picture still covers the top of the view: no black band slid in above it.
    const top = BOX.height / 2 + next.panY - (VIDEO.height / 2) * 4;
    expect(top).toBeLessThanOrEqual(1e-6);
  });

  it("stops at the desktop's edge: the picture's edge meets the view's edge, never passes it", () => {
    const t = { scale: 3, panX: 0, panY: 0 };
    const next = followCursor(t, { xFrac: 1, yFrac: 0.5 }, VIDEO, BOX);
    const pictureRight = BOX.width / 2 + next.panX + (VIDEO.width / 2) * 3;
    expect(pictureRight).toBeCloseTo(BOX.width, 6);
  });

  it("never undoes a pan the user took further than the edge", () => {
    // Panned left past the edge, cursor near the left of the view: following would pull the
    // picture right, but not beyond where the user already had it.
    const t = { scale: 2, panX: -500, panY: 0 };
    const next = followCursor(t, { xFrac: 0.9, yFrac: 0.5 }, VIDEO, BOX);
    expect(next.panX).toBeGreaterThanOrEqual(-500);
  });
});
