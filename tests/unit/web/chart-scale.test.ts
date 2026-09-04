// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/chart-scale.test.ts
import { describe, it, expect } from "bun:test";
import { resolveScaleMax, resolveCssColor } from "../../../src/web/components/system/chart-scale.ts";

describe("resolveScaleMax", () => {
  it("a fixed maxValue always wins, regardless of the data", () => {
    expect(resolveScaleMax([3], 100)).toBe(100);
    expect(resolveScaleMax([500], 100)).toBe(100);
  });

  it("a low reading does not get scaled to fill the chart when maxValue is fixed", () => {
    // Regression for the bug: 3% CPU used to render as a full-height line because the
    // old code always did Math.max(...data, 1) with no fixed-scale option.
    const max = resolveScaleMax([3, 2, 4], 100);
    expect(max).toBe(100);
    expect(3 / max).toBeCloseTo(0.03);
  });

  it("autoscales to the max of the window when maxValue is omitted (byte-rate axes)", () => {
    expect(resolveScaleMax([10, 500, 20])).toBe(500);
  });

  it("floors autoscale at 1 so an all-zero series does not divide by zero", () => {
    expect(resolveScaleMax([0, 0, 0])).toBe(1);
  });
});

/** Fake `CSSStyleDeclaration` — just the one method `resolveCssColor` calls. */
function fakeStyles(vars: Record<string, string>): { getPropertyValue(prop: string): string } {
  return { getPropertyValue: (prop) => vars[prop] ?? "" };
}

describe("resolveCssColor", () => {
  it("resolves a var(...) reference against the given computed style", () => {
    const styles = fakeStyles({ "--color-primary": "#3b82f6" });
    expect(resolveCssColor("var(--color-primary)", styles)).toBe("#3b82f6");
  });

  it("trims whitespace from the resolved custom property value", () => {
    const styles = fakeStyles({ "--color-primary": "  #3b82f6  " });
    expect(resolveCssColor("var(--color-primary)", styles)).toBe("#3b82f6");
  });

  it("passes through a plain color untouched — not every strokeStyle is a var()", () => {
    const styles = fakeStyles({});
    expect(resolveCssColor("#ff0000", styles)).toBe("#ff0000");
    expect(resolveCssColor("red", styles)).toBe("red");
  });

  it("falls back to the original var(...) string when the property resolves to nothing", () => {
    // Regression for the bug this fixes: Canvas 2D silently ignores an unresolved
    // var() and keeps the previous strokeStyle (black) — better to at least attempt
    // the literal string than resolve to an empty, definitely-invalid color.
    const styles = fakeStyles({});
    expect(resolveCssColor("var(--missing-token)", styles)).toBe("var(--missing-token)");
  });
});
