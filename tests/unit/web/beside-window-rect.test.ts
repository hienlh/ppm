import { describe, expect, it } from "bun:test";
import { besideWindowRect } from "../../../src/web/lib/beside-window-rect";
import { MIN_SIZE } from "../../../src/web/components/floating-window/window-geometry";

const bounds = { w: 1600, h: 900 };

describe("besideWindowRect", () => {
  it("stands to the anchor's right, at the anchor's height, when that fits", () => {
    const rect = besideWindowRect({ x: 40, y: 50, w: 900, h: 700 }, bounds);
    expect(rect.x).toBe(40 + 900 + 12);
    expect(rect.y).toBe(50);
    expect(rect.h).toBe(700);
    expect(rect.x + rect.w).toBeLessThanOrEqual(bounds.w);
  });

  it("narrows to the room on the right before covering the anchor", () => {
    const rect = besideWindowRect({ x: 40, y: 50, w: 1100, h: 700 }, bounds);
    expect(rect.x).toBe(1152);
    expect(rect.w).toBe(bounds.w - 1152);
    expect(rect.w).toBeGreaterThanOrEqual(MIN_SIZE.w);
  });

  it("goes to the left when only the left has room", () => {
    const rect = besideWindowRect({ x: 700, y: 50, w: 880, h: 700 }, bounds);
    expect(rect.x + rect.w).toBe(700 - 12);
    expect(rect.x).toBeGreaterThanOrEqual(0);
  });

  it("overlaps the anchor's right edge a titlebar lower when neither side has room", () => {
    const anchor = { x: 48, y: 48, w: 886, h: 672 };
    const rect = besideWindowRect(anchor, { w: 1230, h: 800 });
    expect(rect.y).toBe(anchor.y + 40);
    expect(rect.x + rect.w).toBe(1230 - 16);
    expect(rect.x).toBeLessThan(anchor.x + anchor.w);
    expect(rect.y + rect.h).toBeLessThanOrEqual(800);
  });

  it("stands at the layer's right edge with nothing to stand beside", () => {
    const rect = besideWindowRect(null, bounds);
    expect(rect.x + rect.w).toBe(bounds.w - 16);
    expect(rect.w).toBeGreaterThanOrEqual(MIN_SIZE.w);
  });
});
