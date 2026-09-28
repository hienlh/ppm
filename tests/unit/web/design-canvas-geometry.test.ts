import { describe, expect, it } from "bun:test";
import { fitFrame, FRAME_PADDING, MIN_FRAME_SCALE } from "../../../src/web/components/design/canvas/canvas-geometry";

describe("fitFrame", () => {
  it("fills the pane when there is no fixed frame", () => {
    expect(fitFrame(null, { width: 900, height: 600 })).toEqual({
      width: 900, height: 600, scale: 1, outerWidth: 900, outerHeight: 600,
    });
  });

  it("keeps the frame's own CSS size and scales it down to fit, padding included", () => {
    const fit = fitFrame({ width: 1280, height: 720 }, { width: 672, height: 1000 });
    expect(fit.width).toBe(1280);
    expect(fit.height).toBe(720);
    expect(fit.scale).toBeCloseTo((672 - 2 * FRAME_PADDING) / 1280, 6);
    expect(fit.outerWidth).toBeCloseTo(672 - 2 * FRAME_PADDING, 6);
  });

  it("is limited by whichever side is tighter", () => {
    const fit = fitFrame({ width: 390, height: 844 }, { width: 2000, height: 500 });
    expect(fit.scale).toBeCloseTo((500 - 2 * FRAME_PADDING) / 844, 6);
  });

  it("never enlarges a small frame on a big pane", () => {
    expect(fitFrame({ width: 390, height: 844 }, { width: 3000, height: 3000 }).scale).toBe(1);
  });

  it("stays finite and positive for a collapsed or garbage pane", () => {
    for (const pane of [{ width: 0, height: 0 }, { width: -5, height: 10 }, { width: Number.NaN, height: Infinity }]) {
      const fit = fitFrame({ width: 820, height: 1180 }, pane);
      expect(Number.isFinite(fit.scale)).toBe(true);
      expect(fit.scale).toBeGreaterThanOrEqual(MIN_FRAME_SCALE);
    }
  });
});
