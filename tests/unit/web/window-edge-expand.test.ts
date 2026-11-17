// Run in Docker (host Bun segfaults on `bun test`): docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/window-edge-expand.test.ts
import { describe, it, expect } from "bun:test";
import { expandToEdge } from "../../../src/web/components/floating-window/window-edge-expand.ts";
import { clampRect, MIN_SIZE, RESIZE_HANDLES, type Rect } from "../../../src/web/components/floating-window/window-geometry.ts";

const BOUNDS = { w: 1600, h: 900 };
const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const WIN = R(300, 200, 600, 400); // right edge 900, bottom edge 600

describe("expandToEdge — one edge", () => {
  it("stretches the bottom edge to the layer's bottom and keeps the top", () => {
    expect(expandToEdge(WIN, "s", BOUNDS)).toEqual(R(300, 200, 600, 700));
  });

  it("stretches the right edge to the layer's right and keeps the left", () => {
    expect(expandToEdge(WIN, "e", BOUNDS)).toEqual(R(300, 200, 1300, 400));
  });

  it("stretches the left edge to 0 and keeps the right", () => {
    expect(expandToEdge(WIN, "w", BOUNDS)).toEqual(R(0, 200, 900, 400));
  });

  it("stretches the top edge to 0 and keeps the bottom", () => {
    expect(expandToEdge(WIN, "n", BOUNDS)).toEqual(R(300, 0, 600, 600));
  });

  it("never touches the other axis", () => {
    for (const handle of ["e", "w"] as const) {
      const r = expandToEdge(WIN, handle, BOUNDS, true);
      expect([r.y, r.h]).toEqual([WIN.y, WIN.h]);
    }
    for (const handle of ["n", "s"] as const) {
      const r = expandToEdge(WIN, handle, BOUNDS, true);
      expect([r.x, r.w]).toEqual([WIN.x, WIN.w]);
    }
  });

  it("is a no-op when the edge already sits on the layer's edge", () => {
    const flush = R(1000, 500, 600, 400);
    expect(expandToEdge(flush, "e", BOUNDS)).toEqual(flush);
    expect(expandToEdge(flush, "s", BOUNDS)).toEqual(flush);
  });
});

describe("expandToEdge — corners", () => {
  it("stretches both edges of each corner", () => {
    expect(expandToEdge(WIN, "se", BOUNDS)).toEqual(R(300, 200, 1300, 700));
    expect(expandToEdge(WIN, "nw", BOUNDS)).toEqual(R(0, 0, 900, 600));
    expect(expandToEdge(WIN, "ne", BOUNDS)).toEqual(R(300, 0, 1300, 600));
    expect(expandToEdge(WIN, "sw", BOUNDS)).toEqual(R(0, 200, 900, 700));
  });
});

describe("expandToEdge — Alt/Option", () => {
  it("fills the axis of the edge from either side", () => {
    expect(expandToEdge(WIN, "e", BOUNDS, true)).toEqual(R(0, 200, 1600, 400));
    expect(expandToEdge(WIN, "w", BOUNDS, true)).toEqual(R(0, 200, 1600, 400));
    expect(expandToEdge(WIN, "s", BOUNDS, true)).toEqual(R(300, 0, 600, 900));
    expect(expandToEdge(WIN, "n", BOUNDS, true)).toEqual(R(300, 0, 600, 900));
  });

  it("on a corner fills the whole layer", () => {
    for (const handle of ["ne", "nw", "se", "sw"] as const) {
      expect(expandToEdge(WIN, handle, BOUNDS, true)).toEqual(R(0, 0, 1600, 900));
    }
  });
});

describe("expandToEdge — limits", () => {
  it("pulls in an unmoved edge that hangs off the layer, so the window fits", () => {
    // Hanging off the left: stretching the right edge cannot leave the left at -200.
    expect(expandToEdge(R(-200, 100, 600, 400), "e", BOUNDS)).toEqual(R(0, 100, 1600, 400));
    // Hanging off the bottom: stretching the top pulls the bottom back to the layer's edge.
    expect(expandToEdge(R(100, 700, 600, 400), "n", BOUNDS)).toEqual(R(100, 0, 600, 900));
  });

  it("keeps the minimum size, holding the edge that moved", () => {
    // Only 48px of this window is on the layer. Its right edge comes back to the layer's
    // edge, and the window keeps its minimum width rather than shrinking to 48px.
    const offRight = R(BOUNDS.w - 48, 100, 600, 400);
    expect(expandToEdge(offRight, "e", BOUNDS)).toEqual(R(BOUNDS.w - MIN_SIZE.w, 100, MIN_SIZE.w, 400));
    // The mirror case: the left edge comes to 0 and the right edge gives way.
    const offLeft = R(48 - 600, 100, 600, 400);
    expect(expandToEdge(offLeft, "w", BOUNDS)).toEqual(R(0, 100, MIN_SIZE.w, 400));
    // Same on the vertical axis.
    const offBottom = R(100, BOUNDS.h - 48, 600, 400);
    expect(expandToEdge(offBottom, "s", BOUNDS)).toEqual(R(100, BOUNDS.h - MIN_SIZE.h, 600, MIN_SIZE.h));
  });

  it("honours a caller's own minimum", () => {
    const min = { w: 700, h: 500 };
    const r = expandToEdge(R(1100, 100, 600, 600), "e", { w: 1200, h: 900 }, false, min);
    expect(r).toEqual(R(500, 100, 700, 600));
  });

  it("keeps a window that sits inside the layer inside it", () => {
    const rects = [WIN, R(0, 0, 1600, 900), R(10, 10, 360, 240), R(1240, 660, 360, 240)];
    for (const rect of rects) {
      for (const handle of RESIZE_HANDLES) {
        for (const both of [false, true]) {
          const r = expandToEdge(rect, handle, BOUNDS, both);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(BOUNDS.w);
          expect(r.y + r.h).toBeLessThanOrEqual(BOUNDS.h);
        }
      }
    }
  });

  it("always returns a rect the store's clamp leaves unchanged", () => {
    const rects = [WIN, R(-300, 0, 800, 300), R(1500, 850, 400, 300), R(10, 10, 360, 240)];
    for (const rect of rects) {
      for (const handle of RESIZE_HANDLES) {
        for (const both of [false, true]) {
          const r = expandToEdge(rect, handle, BOUNDS, both);
          expect(clampRect(r, BOUNDS)).toEqual(r);
        }
      }
    }
  });
});
