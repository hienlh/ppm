import { describe, it, expect } from "bun:test";
import {
  IDENTITY_TRANSFORM, fittedMaxSize, isIdentity, rotateClockwise, rotateCounterClockwise, toCssTransform,
} from "../../../src/web/components/editor/video-player/video-transform.ts";
import { formatClock } from "../../../src/web/components/editor/video-player/video-player-controls.tsx";

describe("video transform", () => {
  it("rotates in 90° steps and wraps", () => {
    let t = IDENTITY_TRANSFORM;
    const seen = [t.rotation];
    for (let i = 0; i < 4; i++) { t = rotateClockwise(t); seen.push(t.rotation); }
    expect(seen).toEqual([0, 90, 180, 270, 0]);
    expect(rotateCounterClockwise(IDENTITY_TRANSFORM).rotation).toBe(270);
  });

  it("builds a CSS transform with flips before rotation", () => {
    expect(toCssTransform(IDENTITY_TRANSFORM)).toBe("none");
    expect(toCssTransform({ rotation: 90, flipH: true, flipV: false })).toBe("rotate(90deg) scaleX(-1)");
    expect(toCssTransform({ rotation: 0, flipH: false, flipV: true })).toBe("scaleY(-1)");
    expect(isIdentity({ rotation: 0, flipH: true, flipV: false })).toBe(false);
  });

  it("swaps the fitting box for sideways rotations", () => {
    const box = { width: 800, height: 450 };
    expect(fittedMaxSize(IDENTITY_TRANSFORM, box)).toEqual({ maxWidth: 800, maxHeight: 450 });
    expect(fittedMaxSize({ rotation: 90, flipH: false, flipV: false }, box)).toEqual({ maxWidth: 450, maxHeight: 800 });
    expect(fittedMaxSize({ rotation: 180, flipH: false, flipV: false }, box)).toEqual({ maxWidth: 800, maxHeight: 450 });
  });
});

describe("formatClock", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(NaN)).toBe("0:00");
  });
});
