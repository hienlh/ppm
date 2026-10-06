/**
 * Where the filter row's slots sit: each column's start, and how far the scrolling ones are moved
 * for what `onVisibleRegionChanged` reports. Measured in a browser for gate B; pinned here so a
 * change to the arithmetic cannot pass unnoticed.
 */
import { describe, expect, it } from "bun:test";
import { columnOffsets, scrollOffset } from "../../../src/web/components/database/grid/grid-header-overlay.tsx";

const COLUMNS = [{ id: "a", width: 100 }, { id: "b", width: 80 }, { id: "c", width: 120 }, { id: "d", width: 60 }];

describe("columnOffsets", () => {
  it("starts each column where the one before it ends", () => {
    expect(columnOffsets(COLUMNS)).toEqual([0, 100, 180, 300]);
    expect(columnOffsets([])).toEqual([]);
  });
});

describe("scrollOffset", () => {
  const offsets = columnOffsets(COLUMNS);

  it("is zero at the start", () => {
    expect(scrollOffset(offsets, 0, { x: 0, tx: 0 })).toBe(0);
  });

  it("adds the part of the first column in view already scrolled past", () => {
    // Column c is the first in view, 30px of it scrolled out to the left.
    expect(scrollOffset(offsets, 0, { x: 2, tx: -30 })).toBe(210);
  });

  it("counts from the first column that is not frozen", () => {
    // a is frozen; the scrolling part begins at b, so being at c means b's 80px went by.
    expect(scrollOffset(offsets, 1, { x: 2, tx: -10 })).toBe(90);
    // Glide reports the frozen column as first in view until the scrolling ones move.
    expect(scrollOffset(offsets, 1, { x: 0, tx: 0 })).toBe(0);
  });

  it("does not move past the last column", () => {
    expect(scrollOffset(offsets, 0, { x: 9, tx: 0 })).toBe(0);
  });
});
