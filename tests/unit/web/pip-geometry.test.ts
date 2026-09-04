import { describe, it, expect } from "bun:test";
import {
  clampPipSize,
  MIN_PIP_WIDTH,
  MIN_PIP_HEIGHT,
} from "../../../src/web/components/floating-window/pip/pip-geometry.ts";

const BOUNDS = { width: 1920, height: 1080 };

describe("clampPipSize", () => {
  it("passes a size inside the bounds through, rounded to whole px", () => {
    expect(clampPipSize({ width: 900.4, height: 600.6 }, BOUNDS)).toEqual({ width: 900, height: 601 });
  });

  it("raises sizes below the usable minimum", () => {
    expect(clampPipSize({ width: 10, height: 0 }, BOUNDS)).toEqual({
      width: MIN_PIP_WIDTH,
      height: MIN_PIP_HEIGHT,
    });
  });

  it("caps sizes at the screen bounds", () => {
    expect(clampPipSize({ width: 5000, height: 4000 }, BOUNDS)).toEqual(BOUNDS);
  });

  it("keeps the minimum when the bounds are smaller than it", () => {
    expect(clampPipSize({ width: 800, height: 800 }, { width: 100, height: 100 })).toEqual({
      width: MIN_PIP_WIDTH,
      height: MIN_PIP_HEIGHT,
    });
  });

  it("collapses non-finite input to the minimum instead of forwarding NaN", () => {
    expect(clampPipSize({ width: Number.NaN, height: Number.POSITIVE_INFINITY }, BOUNDS)).toEqual({
      width: MIN_PIP_WIDTH,
      height: MIN_PIP_HEIGHT,
    });
  });

  it("handles negative input", () => {
    expect(clampPipSize({ width: -50, height: -1 }, BOUNDS)).toEqual({
      width: MIN_PIP_WIDTH,
      height: MIN_PIP_HEIGHT,
    });
  });
});
