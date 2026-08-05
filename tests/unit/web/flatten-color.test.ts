import { describe, test, expect } from "bun:test";
import { flattenColor } from "../../../src/web/lib/color-utils";

describe("flattenColor", () => {
  test("composites the translucent Aurora Light panel onto the page background", () => {
    // aurora-light: panel rgba(255,255,255,0.62) over bgSolid #f3f7ff
    expect(flattenColor("rgba(255,255,255,0.62)", "#f3f7ff")).toBe("rgb(250, 252, 255)");
  });

  test("composites the translucent Aurora Dark panel", () => {
    expect(flattenColor("rgba(255, 255, 255, 0.04)", "#0a0e17")).toBe("rgb(20, 24, 32)");
  });

  test("leaves opaque colors untouched", () => {
    expect(flattenColor("#1e2028", "#0a0e17")).toBe("#1e2028");
    expect(flattenColor("rgb(30, 32, 40)", "#0a0e17")).toBe("rgb(30, 32, 40)");
  });

  test("supports shorthand hex and hex alpha", () => {
    expect(flattenColor("#fff", "#000000")).toBe("#fff");
    expect(flattenColor("#ffffff80", "#000000")).toBe("rgb(128, 128, 128)");
  });

  test("returns the input when a color cannot be parsed", () => {
    expect(flattenColor("oklch(0.7 0.1 250 / 0.5)", "#000000")).toBe("oklch(0.7 0.1 250 / 0.5)");
    expect(flattenColor("rgba(255,255,255,0.5)", "var(--nope)")).toBe("rgba(255,255,255,0.5)");
  });
});
