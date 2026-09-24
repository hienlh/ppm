import { describe, expect, it } from "bun:test";
import { applyDrag, formatPx, parseTranslate, zoneAt } from "../../../src/services/design/bridge/bridge-transform-math.ts";

const start = { tx: 10, ty: 20, w: 200, h: 100 };

describe("parseTranslate", () => {
  it("reads px offsets, a bare zero and none", () => {
    expect(parseTranslate("none")).toEqual({ x: 0, y: 0 });
    expect(parseTranslate("")).toEqual({ x: 0, y: 0 });
    expect(parseTranslate(null)).toEqual({ x: 0, y: 0 });
    expect(parseTranslate("12px")).toEqual({ x: 12, y: 0 });
    expect(parseTranslate("12.5px -4px")).toEqual({ x: 12.5, y: -4 });
    expect(parseTranslate("0 3px")).toEqual({ x: 0, y: 3 });
    expect(parseTranslate(" 1px 2px 0px ")).toEqual({ x: 1, y: 2 });
  });

  it("refuses what the handles cannot extend without changing its meaning", () => {
    for (const v of ["10%", "1px 2px 3px", "calc(1px + 2px)", "3", "1em 2px", "1px 2px 0px 4px", "abc"]) {
      expect(parseTranslate(v)).toBeNull();
    }
  });
});

describe("formatPx", () => {
  it("rounds to two decimals, clamps to 20000 and never says -0", () => {
    expect(formatPx(12)).toBe("12px");
    expect(formatPx(12.345)).toBe("12.35px");
    expect(formatPx(-0.001)).toBe("0px");
    expect(formatPx(99999)).toBe("20000px");
    expect(formatPx(-99999)).toBe("-20000px");
    expect(formatPx(Number.NaN)).toBe("0px");
  });
});

describe("applyDrag", () => {
  it("moves by the pointer delta", () => {
    expect(applyDrag(start, "move", 5, -7)).toEqual({ tx: 15, ty: 13, w: 200, h: 100 });
  });

  it("resizes from the right and bottom without touching the offset", () => {
    expect(applyDrag(start, "se", 30, 40)).toEqual({ tx: 10, ty: 20, w: 230, h: 140 });
    expect(applyDrag(start, "e", -50, 999)).toEqual({ tx: 10, ty: 20, w: 150, h: 100 });
    expect(applyDrag(start, "s", 999, 5)).toEqual({ tx: 10, ty: 20, w: 200, h: 105 });
  });

  it("keeps the opposite edge in place when resizing from the left or top", () => {
    expect(applyDrag(start, "nw", 20, 10)).toEqual({ tx: 30, ty: 30, w: 180, h: 90 });
    expect(applyDrag(start, "w", -15, 0)).toEqual({ tx: -5, ty: 20, w: 215, h: 100 });
  });

  it("never shrinks below the floor, and the offset stops with it", () => {
    expect(applyDrag(start, "w", 500, 0)).toEqual({ tx: 209, ty: 20, w: 1, h: 100 });
    expect(applyDrag(start, "n", 0, 500, 10)).toEqual({ tx: 10, ty: 110, w: 200, h: 10 });
    expect(applyDrag(start, "se", -500, -500)).toMatchObject({ w: 1, h: 1 });
  });
});

describe("zoneAt", () => {
  const rect = { x: 100, y: 100, w: 200, h: 100 };
  it("finds corners, edge midpoints and the move area", () => {
    expect(zoneAt(rect, 100, 100, 44)).toBe("nw");
    expect(zoneAt(rect, 318, 215, 44)).toBe("se");
    expect(zoneAt(rect, 200, 100, 44)).toBe("n");
    expect(zoneAt(rect, 300, 150, 44)).toBe("e");
    expect(zoneAt(rect, 200, 150, 44)).toBe("move");
    expect(zoneAt(rect, 120, 120, 44)).toBe("nw");
    expect(zoneAt(rect, 160, 130, 44)).toBe("move");
  });

  it("is null well outside the element and its handles", () => {
    expect(zoneAt(rect, 50, 50, 44)).toBeNull();
    expect(zoneAt(rect, 250, 80, 44)).toBeNull();
  });

  it("lets a tiny element still be dragged by its centre", () => {
    expect(zoneAt({ x: 0, y: 0, w: 20, h: 20 }, 10, 10, 44)).toBe("move");
    expect(zoneAt({ x: 0, y: 0, w: 20, h: 20 }, 1, 1, 44)).toBe("nw");
  });
});
