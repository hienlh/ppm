// Run in Docker (host Bun segfaults on `bun test`): docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/window-geometry.test.ts
import { describe, it, expect } from "bun:test";
import {
  applyResize,
  cascadeSpawnRect,
  clampRect,
  nudgeRect,
  windowZIndex,
  KEEP_VISIBLE,
  MAX_WINDOWS,
  MIN_SIZE,
  RESIZE_HANDLES,
  Z_BASE,
  type Rect,
} from "../../../src/web/components/floating-window/window-geometry.ts";

const BOUNDS = { w: 1600, h: 900 };
const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("clampRect", () => {
  it("leaves an already-valid rect untouched", () => {
    expect(clampRect(R(100, 80, 800, 500), BOUNDS)).toEqual(R(100, 80, 800, 500));
  });

  it("enforces the minimum size", () => {
    expect(clampRect(R(10, 10, 40, 20), BOUNDS)).toEqual(R(10, 10, MIN_SIZE.w, MIN_SIZE.h));
  });

  it("never exceeds the layer size", () => {
    const out = clampRect(R(0, 0, 9999, 9999), BOUNDS);
    expect(out.w).toBe(BOUNDS.w);
    expect(out.h).toBe(BOUNDS.h);
  });

  it("keeps the minimum size even when the layer is smaller than it", () => {
    const out = clampRect(R(0, 0, 100, 100), { w: 200, h: 150 });
    expect(out).toEqual(R(0, 0, MIN_SIZE.w, MIN_SIZE.h));
  });

  it("keeps KEEP_VISIBLE px on screen when dragged off the right edge", () => {
    const out = clampRect(R(5000, 100, 800, 500), BOUNDS);
    expect(out.x).toBe(BOUNDS.w - KEEP_VISIBLE);
  });

  it("keeps KEEP_VISIBLE px on screen when dragged off the left edge", () => {
    const out = clampRect(R(-5000, 100, 800, 500), BOUNDS);
    expect(out.x).toBe(KEEP_VISIBLE - 800);
    expect(out.x + out.w).toBe(KEEP_VISIBLE);
  });

  it("never lets the titlebar go above the layer, or below its bottom edge", () => {
    expect(clampRect(R(100, -400, 800, 500), BOUNDS).y).toBe(0);
    expect(clampRect(R(100, 5000, 800, 500), BOUNDS).y).toBe(BOUNDS.h - KEEP_VISIBLE);
  });

  it("rounds to whole pixels", () => {
    expect(clampRect(R(10.4, 20.6, 800.3, 500.9), BOUNDS)).toEqual(R(10, 21, 800, 501));
  });
});

describe("applyResize", () => {
  const base = R(200, 150, 800, 500);

  it("east / south move only the far edge", () => {
    expect(applyResize(base, "e", 100, 0)).toEqual(R(200, 150, 900, 500));
    expect(applyResize(base, "s", 0, 60)).toEqual(R(200, 150, 800, 560));
  });

  it("west / north move the origin and keep the anchored edge fixed", () => {
    const w = applyResize(base, "w", 100, 0);
    expect(w).toEqual(R(300, 150, 700, 500));
    expect(w.x + w.w).toBe(base.x + base.w);
    const n = applyResize(base, "n", 0, 50);
    expect(n).toEqual(R(200, 200, 800, 450));
    expect(n.y + n.h).toBe(base.y + base.h);
  });

  it("corner handles combine both axes", () => {
    expect(applyResize(base, "se", 40, 30)).toEqual(R(200, 150, 840, 530));
    expect(applyResize(base, "nw", 40, 30)).toEqual(R(240, 180, 760, 470));
    expect(applyResize(base, "ne", 40, 30)).toEqual(R(200, 180, 840, 470));
    expect(applyResize(base, "sw", 40, 30)).toEqual(R(240, 150, 760, 530));
  });

  it("every handle refuses to shrink past the minimum size", () => {
    for (const handle of RESIZE_HANDLES) {
      const out = applyResize(base, handle, -5000, -5000);
      expect(out.w).toBeGreaterThanOrEqual(MIN_SIZE.w);
      expect(out.h).toBeGreaterThanOrEqual(MIN_SIZE.h);
      const out2 = applyResize(base, handle, 5000, 5000);
      expect(out2.w).toBeGreaterThanOrEqual(MIN_SIZE.w);
      expect(out2.h).toBeGreaterThanOrEqual(MIN_SIZE.h);
    }
  });

  it("pins the anchored edge when a west/north drag hits the minimum", () => {
    const w = applyResize(base, "w", 5000, 0);
    expect(w.w).toBe(MIN_SIZE.w);
    expect(w.x + w.w).toBe(base.x + base.w);
    const n = applyResize(base, "n", 0, 5000);
    expect(n.h).toBe(MIN_SIZE.h);
    expect(n.y + n.h).toBe(base.y + base.h);
  });

  it("leaves the perpendicular axis alone for edge handles", () => {
    expect(applyResize(base, "e", 100, 999).h).toBe(base.h);
    expect(applyResize(base, "n", 999, -50).w).toBe(base.w);
  });
});

describe("cascadeSpawnRect", () => {
  it("offsets each new window and stays inside the layer", () => {
    const rects: Rect[] = [];
    for (let i = 0; i < MAX_WINDOWS; i++) {
      const r = cascadeSpawnRect(rects, BOUNDS);
      expect(clampRect(r, BOUNDS)).toEqual(r);
      rects.push(r);
    }
    expect(rects[1]!.x - rects[0]!.x).toBe(24);
    expect(rects[1]!.y - rects[0]!.y).toBe(24);
    expect(new Set(rects.map((r) => `${r.x},${r.y}`)).size).toBe(MAX_WINDOWS);
  });

  it("wraps back to the first slot after the cap", () => {
    const filler = Array.from({ length: MAX_WINDOWS }, () => R(0, 0, 400, 300));
    expect(cascadeSpawnRect(filler, BOUNDS)).toEqual(cascadeSpawnRect([], BOUNDS));
  });

  it("shrinks to fit a small layer without breaking the minimum size", () => {
    const r = cascadeSpawnRect([], { w: 500, h: 400 });
    expect(r.w).toBeGreaterThanOrEqual(MIN_SIZE.w);
    expect(r.h).toBeGreaterThanOrEqual(MIN_SIZE.h);
    expect(r.w).toBeLessThanOrEqual(500);
  });
});

describe("nudgeRect", () => {
  it("moves by the delta and re-clamps", () => {
    expect(nudgeRect(R(100, 100, 800, 500), -10, 10, BOUNDS)).toEqual(R(90, 110, 800, 500));
    expect(nudgeRect(R(0, 0, 800, 500), 0, -10, BOUNDS).y).toBe(0);
  });
});

describe("windowZIndex", () => {
  it("stays inside the reserved band below the app's z-40 backdrops", () => {
    expect(windowZIndex(0)).toBe(Z_BASE);
    expect(windowZIndex(MAX_WINDOWS - 1)).toBe(37);
    expect(windowZIndex(999)).toBeLessThanOrEqual(38);
    expect(windowZIndex(-5)).toBe(Z_BASE);
  });
});
