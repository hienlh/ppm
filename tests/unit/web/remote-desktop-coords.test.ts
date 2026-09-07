// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/remote-desktop-coords.test.ts
import { describe, it, expect } from "bun:test";
import { fractionFromPoint, fractionFromZoomedPoint, letterboxedContentRect } from "../../../src/web/components/remote-desktop/remote-desktop-coords.ts";

describe("fractionFromPoint", () => {
  it("maps the canvas center to 0.5/0.5", () => {
    const rect = { left: 100, top: 50, width: 800, height: 600 };
    expect(fractionFromPoint(500, 350, rect)).toEqual({ xFrac: 0.5, yFrac: 0.5 });
  });

  it("maps the top-left corner to 0/0", () => {
    const rect = { left: 100, top: 50, width: 800, height: 600 };
    expect(fractionFromPoint(100, 50, rect)).toEqual({ xFrac: 0, yFrac: 0 });
  });

  it("clamps a point outside the rect (fast drag past the edge)", () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 };
    expect(fractionFromPoint(-50, 700, rect)).toEqual({ xFrac: 0, yFrac: 1 });
  });

  it("ignores devicePixelRatio entirely — only CSS-pixel rect fractions are computed", () => {
    // No devicePixelRatio parameter exists on the function signature at all; this test
    // documents that guarantee so a future edit can't silently reintroduce it.
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    expect(fractionFromPoint(50, 50, rect)).toEqual({ xFrac: 0.5, yFrac: 0.5 });
  });
});

describe("fractionFromZoomedPoint", () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 };

  it("matches fractionFromPoint at the identity transform (scale 1, no pan)", () => {
    const identity = { scale: 1, panX: 0, panY: 0 };
    expect(fractionFromZoomedPoint(200, 150, rect, identity)).toEqual(fractionFromPoint(200, 150, rect));
  });

  it("a 2x zoom about the container center maps a screen point closer to center", () => {
    // Container center is (400, 300). A point at (600, 300) is 200px right of center on
    // screen; at 2x zoom the same host point is only 100px right of center pre-zoom.
    const zoomed = { scale: 2, panX: 0, panY: 0 };
    const { xFrac } = fractionFromZoomedPoint(600, 300, rect, zoomed);
    expect(xFrac).toBeCloseTo(0.5 + 100 / 800, 5);
  });

  it("panning shifts the mapped point by the pan amount, reversed", () => {
    // Pan moved the view +50px right on screen — a screen point must be read 50px further
    // left in host space to land on the same host pixel it did before panning.
    const panned = { scale: 1, panX: 50, panY: 0 };
    const base = fractionFromZoomedPoint(400, 300, rect, { scale: 1, panX: 0, panY: 0 });
    const withPan = fractionFromZoomedPoint(450, 300, rect, panned);
    expect(withPan.xFrac).toBeCloseTo(base.xFrac, 5);
  });

  it("clamps a point the transform maps past the container edge to 0..1", () => {
    // An extreme pan pushes the reverse-mapped point far past the container's right edge.
    const panned = { scale: 1, panX: -10_000, panY: 0 };
    const { xFrac } = fractionFromZoomedPoint(400, 300, rect, panned);
    expect(xFrac).toBe(1);
  });

  it("exactly inverts a combined zoom+pan for an arbitrary point (round-trip)", () => {
    // Forward-map a known base (host) point the same way the CSS `transform:
    // translate(panX,panY) scale(scale)` (default center transform-origin) actually renders
    // it on screen, then confirm fractionFromZoomedPoint recovers the original fraction. This
    // is the exact bug class a transform-origin/order mismatch would produce: forward and
    // inverse disagreeing about where "center" is or which operation applies first.
    const transform = { scale: 2.5, panX: 37, panY: -64 };
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const baseX = 210; // arbitrary point, deliberately off-center and off-grid
    const baseY = 480;
    const screenX = cx + transform.scale * (baseX - cx) + transform.panX;
    const screenY = cy + transform.scale * (baseY - cy) + transform.panY;

    const expected = fractionFromPoint(baseX, baseY, rect);
    const actual = fractionFromZoomedPoint(screenX, screenY, rect, transform);
    expect(actual.xFrac).toBeCloseTo(expected.xFrac, 9);
    expect(actual.yFrac).toBeCloseTo(expected.yFrac, 9);
  });

  it("a tap at the exact center of a zoomed+panned view still hits 0.5/0.5 pre-zoom center offset by pan", () => {
    // Regression guard for the reported "zoomed tap lands in the wrong spot" bug: the visual
    // center of the container should map back to the container's geometric center only when
    // pan is zero; once panned, tapping the container's visual center must resolve to
    // whatever host point the pan moved under it — not silently ignore the pan.
    const zoomedAndPanned = { scale: 3, panX: 40, panY: 0 };
    const containerCenterScreen = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const { xFrac } = fractionFromZoomedPoint(containerCenterScreen.x, containerCenterScreen.y, rect, zoomedAndPanned);
    // baseX = cx + (screenX - cx - panX)/scale = cx + (0 - 40)/3 → left of center by 40/3/width
    expect(xFrac).toBeCloseTo(0.5 - 40 / 3 / rect.width, 9);
  });
});

describe("letterboxedContentRect", () => {
  it("letterboxes top/bottom when the content is relatively WIDER than the box (16:9 capture on a portrait phone)", () => {
    const box = { left: 0, top: 0, width: 390, height: 600 };
    const rect = letterboxedContentRect(box, 1920, 1080);
    expect(rect.width).toBeCloseTo(390, 6); // full width used
    expect(rect.height).toBeCloseTo(390 / (1920 / 1080), 6);
    expect(rect.left).toBe(0);
    // Centered vertically within the box.
    expect(rect.top).toBeCloseTo((box.height - rect.height) / 2, 6);
  });

  it("letterboxes left/right when the content is relatively TALLER/narrower than the box", () => {
    const box = { left: 0, top: 0, width: 800, height: 600 };
    const rect = letterboxedContentRect(box, 1080, 1920); // portrait capture in a landscape box
    expect(rect.height).toBeCloseTo(600, 6); // full height used
    expect(rect.width).toBeCloseTo(600 * (1080 / 1920), 6);
    expect(rect.top).toBe(0);
    expect(rect.left).toBeCloseTo((box.width - rect.width) / 2, 6);
  });

  it("its own center always coincides with the box's center (object-position: 50% 50%)", () => {
    const box = { left: 10, top: 20, width: 390, height: 600 };
    const rect = letterboxedContentRect(box, 1920, 1080);
    expect(rect.left + rect.width / 2).toBeCloseTo(box.left + box.width / 2, 6);
    expect(rect.top + rect.height / 2).toBeCloseTo(box.top + box.height / 2, 6);
  });

  it("falls back to the box unchanged before the first frame sets a content size", () => {
    const box = { left: 0, top: 0, width: 390, height: 600 };
    expect(letterboxedContentRect(box, 0, 0)).toEqual(box);
  });
});

describe("letterboxedContentRect + fractionFromZoomedPoint (combined)", () => {
  it("a tap inside a letterboxed AND zoomed video maps to the correct capture fraction, not the raw screen position", () => {
    // Portrait phone box, 16:9 desktop capture — well over half the box is letterbox bars.
    const box = { left: 0, top: 0, width: 390, height: 600 };
    const videoRect = letterboxedContentRect(box, 1920, 1080);
    const transform = { scale: 2, panX: 10, panY: -5 };

    // Forward-map an arbitrary base (capture-space) point through the zoom exactly as the CSS
    // transform renders it, using the LETTERBOXED rect's own center (matches the mobile view:
    // the stage/canvas fills `box`, but the video content — and this test's reference frame —
    // is `videoRect`).
    const cx = videoRect.left + videoRect.width / 2;
    const cy = videoRect.top + videoRect.height / 2;
    const baseX = videoRect.left + 0.75 * videoRect.width; // arbitrary point inside the video
    const baseY = videoRect.top + 0.2 * videoRect.height;
    const screenX = cx + transform.scale * (baseX - cx) + transform.panX;
    const screenY = cy + transform.scale * (baseY - cy) + transform.panY;

    const expected = fractionFromPoint(baseX, baseY, videoRect);
    const actual = fractionFromZoomedPoint(screenX, screenY, videoRect, transform);
    expect(actual.xFrac).toBeCloseTo(expected.xFrac, 9);
    expect(actual.yFrac).toBeCloseTo(expected.yFrac, 9);
    expect(actual.xFrac).toBeCloseTo(0.75, 9);
    expect(actual.yFrac).toBeCloseTo(0.2, 9);
  });

  it("a tap in the letterbox bar (outside the video) clamps to the nearest video edge, never the raw box", () => {
    const box = { left: 0, top: 0, width: 390, height: 600 };
    const videoRect = letterboxedContentRect(box, 1920, 1080); // short, centered band within box
    const identity = { scale: 1, panX: 0, panY: 0 };
    // A tap near the very top of the (tall) box lands above the (short) video band entirely.
    const { yFrac } = fractionFromZoomedPoint(box.left + box.width / 2, box.top + 5, videoRect, identity);
    expect(yFrac).toBe(0); // clamped to the video's top edge, not a negative/garbage fraction
  });
});
