/**
 * RustDesk's `ViewStyle`, ported. The tests worth having are about the two things that fail
 * silently: a mode string that is not a mode, and a CSS length that is not a number.
 */
import { describe, it, expect } from "bun:test";
import {
  CUSTOM_SCALE_MAX, CUSTOM_SCALE_MAX_PERCENT, CUSTOM_SCALE_MIN, CUSTOM_SCALE_MIN_PERCENT,
  DEFAULT_VIEW_STYLE, VIEW_STYLE_ORDER, canvasCssSize, clampCustomScale, clampScalePercent,
  parseViewStyle, scalePercentToPos, scalePosToPercent, snapScalePos, stepCustomScale,
  viewStyleShortLabel,
} from "../../../src/web/components/remote-desktop/remote-desktop-view-style";

const UHD = { width: 3440, height: 1440 };

describe("parseViewStyle", () => {
  it("accepts the three real modes", () => {
    for (const style of VIEW_STYLE_ORDER) expect(parseViewStyle(style)).toBe(style);
  });

  it("falls back to adaptive, which is the mode that always shows the whole screen", () => {
    expect(DEFAULT_VIEW_STYLE).toBe("adaptive");
    for (const bad of ["fit", "", "ADAPTIVE", null, 3, {}]) expect(parseViewStyle(bad)).toBe("adaptive");
  });

  it("refuses a prototype key", () => {
    // `VIEW_STYLE_LABELS["toString"]` would otherwise be a function used as a label.
    for (const bad of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(parseViewStyle(bad)).toBe("adaptive");
    }
  });
});

describe("clampCustomScale", () => {
  it("holds the zoom inside the supported range", () => {
    expect(clampCustomScale(0.01)).toBe(CUSTOM_SCALE_MIN);
    expect(clampCustomScale(99)).toBe(CUSTOM_SCALE_MAX);
    expect(clampCustomScale(1.5)).toBe(1.5);
  });

  it("never lets a non-number reach a CSS length", () => {
    // `width: NaNpx` is dropped silently and the canvas collapses to nothing — no error, no
    // warning, just an invisible remote screen.
    for (const bad of [NaN, Infinity, -Infinity, "abc", null, undefined, {}]) {
      expect(clampCustomScale(bad)).toBe(1);
    }
  });

  it("steps one percentage point, like RustDesk's nudgeScale", () => {
    expect(stepCustomScale(1, 1)).toBe(1.01);
    expect(stepCustomScale(1.01, -1)).toBe(1);
    // The step is computed in percent and divided back, so it cannot drift off the grid the
    // way `1 + 0.01` does in binary floating point.
    expect(stepCustomScale(0.07, 1)).toBe(0.08);
    expect(stepCustomScale(CUSTOM_SCALE_MIN, -1)).toBe(CUSTOM_SCALE_MIN);
    expect(stepCustomScale(CUSTOM_SCALE_MAX, 1)).toBe(CUSTOM_SCALE_MAX);
  });
});

/* The mapping is ported from RustDesk's `custom_scale_base.dart`. It exists because the range is
 * 5%–1000%: a linear slider would put 100% at 9.5% of the track, i.e. the one value anybody
 * wants would sit jammed against the left stop. */
describe("custom scale slider mapping", () => {
  it("puts 100% exactly one third along the track", () => {
    expect(scalePercentToPos(100)).toBeCloseTo(1 / 3, 10);
    expect(scalePosToPercent(1 / 3)).toBe(100);
    // The bug this guards: a linear map would land here instead.
    expect(scalePercentToPos(100)).not.toBeCloseTo((100 - 5) / (1000 - 5), 3);
  });

  it("spans the whole range at the stops", () => {
    expect(scalePosToPercent(0)).toBe(CUSTOM_SCALE_MIN_PERCENT);
    expect(scalePosToPercent(1)).toBe(CUSTOM_SCALE_MAX_PERCENT);
    expect(scalePercentToPos(CUSTOM_SCALE_MIN_PERCENT)).toBe(0);
    expect(scalePercentToPos(CUSTOM_SCALE_MAX_PERCENT)).toBe(1);
  });

  it("round-trips every percent in the range", () => {
    for (let pct = CUSTOM_SCALE_MIN_PERCENT; pct <= CUSTOM_SCALE_MAX_PERCENT; pct++) {
      expect(scalePosToPercent(scalePercentToPos(pct))).toBe(pct);
    }
  });

  it("is monotonic across the pivot", () => {
    let previous = -1;
    for (let i = 0; i <= 1000; i++) {
      const pct = scalePosToPercent(i / 1000);
      expect(pct).toBeGreaterThanOrEqual(previous);
      previous = pct;
    }
  });

  it("snaps back onto exactly 100% near the pivot", () => {
    // Without the detent, 100% is one position out of ~995 and a drag can never hit it.
    expect(scalePosToPercent(snapScalePos(1 / 3 + 0.005))).toBe(100);
    expect(scalePosToPercent(snapScalePos(1 / 3 - 0.005))).toBe(100);
    // Just outside the detent it must NOT snap, or the slider sticks.
    expect(scalePosToPercent(snapScalePos(1 / 3 + 0.02))).not.toBe(100);
  });

  it("keeps a dragged position inside the track", () => {
    expect(snapScalePos(-5)).toBe(0);
    expect(snapScalePos(9)).toBe(1);
    expect(snapScalePos(NaN)).toBe(1 / 3);
  });

  it("clamps percents the way RustDesk bounds them", () => {
    expect(clampScalePercent(0)).toBe(5);
    expect(clampScalePercent(99999)).toBe(1000);
    expect(clampScalePercent(NaN)).toBe(100);
    expect(clampScalePercent(42.6)).toBe(43);
  });
});

describe("canvasCssSize", () => {
  it("leaves adaptive to the stylesheet", () => {
    // The default mode must keep computing nothing — that is the behaviour the viewer has
    // always had, and the one path that cannot be allowed to regress.
    expect(canvasCssSize("adaptive", 2, UHD)).toBeNull();
  });

  it("gives original the capture's own pixel size", () => {
    expect(canvasCssSize("original", 2, UHD)).toEqual(UHD);
  });

  it("scales custom off the capture, not the viewport", () => {
    expect(canvasCssSize("custom", 0.5, UHD)).toEqual({ width: 1720, height: 720 });
    expect(canvasCssSize("custom", 2, UHD)).toEqual({ width: 6880, height: 2880 });
  });

  it("clamps a custom scale it was handed out of range", () => {
    // CUSTOM_SCALE_MAX is 10 (RustDesk's 1000%), so 99 clamps to a 10x canvas.
    expect(canvasCssSize("custom", 99, UHD)).toEqual({ width: 34400, height: 14400 });
  });

  it("declines to size a capture that has no frames yet", () => {
    // Before the first decoded frame the canvas is 0x0; pinning it there would keep it at 0x0.
    for (const empty of [{ width: 0, height: 0 }, { width: 1920, height: 0 }]) {
      expect(canvasCssSize("original", 1, empty)).toBeNull();
    }
  });
});

it("names each mode compactly for a small control", () => {
  expect(viewStyleShortLabel("adaptive", 1)).toBe("Fit");
  expect(viewStyleShortLabel("original", 1)).toBe("1:1");
  expect(viewStyleShortLabel("custom", 1.25)).toBe("125%");
});
