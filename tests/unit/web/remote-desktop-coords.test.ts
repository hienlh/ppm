// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/remote-desktop-coords.test.ts
import { describe, it, expect } from "bun:test";
import { fractionFromPoint, fractionFromZoomedPoint } from "../../../src/web/components/remote-desktop/remote-desktop-coords.ts";

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
