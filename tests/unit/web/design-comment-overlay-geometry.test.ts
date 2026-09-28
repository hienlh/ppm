import { describe, expect, it } from "bun:test";
import { fitFrame } from "../../../src/web/components/design/canvas/canvas-geometry.ts";
import { barPosition, frameOrigin, pinCenter, rectVisible } from "../../../src/web/components/design/comments/comment-overlay-geometry.ts";

const stage = { width: 800, height: 600 };

describe("comment overlay geometry", () => {
  it("maps a frame rect through the centred, scaled frame", () => {
    const fit = fitFrame({ width: 390, height: 844 }, stage);
    const o = frameOrigin(fit, stage);
    expect(o.left).toBeCloseTo((800 - 390 * fit.scale) / 2);
    const p = pinCenter({ x: 100, y: 200, w: 50, h: 20 }, fit, stage);
    expect(p.left).toBeCloseTo(o.left + 150 * fit.scale);
    expect(p.top).toBeCloseTo(o.top + 200 * fit.scale);
  });

  it("keeps a pin inside the frame when its element touches an edge", () => {
    const fit = fitFrame(null, stage);
    expect(pinCenter({ x: 700, y: 0, w: 100, h: 20 }, fit, stage)).toEqual({ left: 786, top: 14 });
  });

  it("knows when an element is scrolled out of the frame", () => {
    const fit = fitFrame(null, stage);
    expect(rectVisible({ x: 0, y: -100, w: 10, h: 50 }, fit)).toBe(false);
    expect(rectVisible({ x: 0, y: -10, w: 10, h: 50 }, fit)).toBe(true);
    expect(rectVisible({ x: 0, y: 600, w: 10, h: 50 }, fit)).toBe(false);
  });

  it("puts the action bar below the element, or above it when there is no room", () => {
    const fit = fitFrame(null, stage);
    const bar = { width: 300, height: 40 };
    expect(barPosition({ x: 10, y: 10, w: 100, h: 30 }, fit, stage, bar)).toEqual({ left: 10, top: 48 });
    expect(barPosition({ x: 700, y: 540, w: 100, h: 50 }, fit, stage, bar)).toEqual({ left: 492, top: 492 });
  });
});
