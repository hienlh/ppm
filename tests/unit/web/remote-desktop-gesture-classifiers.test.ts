// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/remote-desktop-gesture-classifiers.test.ts
import { describe, it, expect } from "bun:test";
import {
  isTapGesture,
  classifyTwoFingerGesture,
  touchDistance,
  touchMidpoint,
} from "../../../src/web/components/remote-desktop/remote-desktop-gesture-classifiers.ts";

describe("isTapGesture", () => {
  it("is a tap when the finger barely moved and released quickly", () => {
    const start = { x: 100, y: 100, t: 0 };
    const end = { x: 103, y: 98, t: 120 };
    expect(isTapGesture(start, end)).toBe(true);
  });

  it("is not a tap once movement exceeds the threshold, even if fast", () => {
    const start = { x: 100, y: 100, t: 0 };
    const end = { x: 130, y: 100, t: 50 };
    expect(isTapGesture(start, end)).toBe(false);
  });

  it("is not a tap once duration exceeds the max, even without moving", () => {
    const start = { x: 100, y: 100, t: 0 };
    const end = { x: 100, y: 100, t: 500 };
    expect(isTapGesture(start, end)).toBe(false);
  });

  it("respects custom thresholds", () => {
    const start = { x: 0, y: 0, t: 0 };
    const end = { x: 20, y: 0, t: 400 };
    expect(isTapGesture(start, end, 25, 500)).toBe(true);
    expect(isTapGesture(start, end, 10, 500)).toBe(false);
  });

  it("is exactly a tap at the threshold boundary (inclusive)", () => {
    const start = { x: 0, y: 0, t: 0 };
    const end = { x: 10, y: 0, t: 300 };
    expect(isTapGesture(start, end, 10, 300)).toBe(true);
  });
});

describe("classifyTwoFingerGesture", () => {
  it("classifies as pinch once the finger spread changes past the threshold", () => {
    expect(classifyTwoFingerGesture(100, 130, 15)).toBe("pinch");
    expect(classifyTwoFingerGesture(100, 70, 15)).toBe("pinch");
  });

  it("classifies as scroll when the finger spread barely changed", () => {
    expect(classifyTwoFingerGesture(100, 105, 15)).toBe("scroll");
    expect(classifyTwoFingerGesture(100, 100, 15)).toBe("scroll");
  });

  it("is symmetric — fingers moving apart or together both read as pinch", () => {
    expect(classifyTwoFingerGesture(200, 250, 15)).toBe(classifyTwoFingerGesture(200, 150, 15));
  });
});

describe("touchDistance / touchMidpoint", () => {
  it("computes Euclidean distance between two touch points", () => {
    expect(touchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("computes the midpoint between two touch points", () => {
    expect(touchMidpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});
