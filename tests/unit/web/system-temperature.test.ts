import { describe, expect, test } from "bun:test";
import {
  formatTemp, parseTempUnit, toFahrenheit, type TempUnit,
} from "../../../src/web/lib/temperature.ts";

describe("toFahrenheit", () => {
  test("the two fixed points", () => {
    expect(toFahrenheit(0)).toBe(32);
    expect(toFahrenheit(100)).toBe(212);
  });

  test("a plausible CPU reading", () => {
    expect(toFahrenheit(45.5)).toBeCloseTo(113.9, 5);
  });

  test("below freezing stays negative", () => {
    expect(toFahrenheit(-40)).toBe(-40);
  });
});

describe("formatTemp", () => {
  test("celsius carries its unit", () => {
    expect(formatTemp(45.5, "c")).toBe("45.5 °C");
  });

  // Neither 45.55 nor 45.65 is exactly representable, and they do not even round
  // the same way — pinned against the real output rather than against what "one
  // decimal place" suggests, which is how a wrong expectation got written here.
  test("rounding is toFixed's, binary representation and all", () => {
    expect(formatTemp(45.55, "c")).toBe(`${(45.55).toFixed(1)} °C`);
    expect(formatTemp(45.65, "c")).toBe(`${(45.65).toFixed(1)} °C`);
  });

  test("fahrenheit converts and carries its own", () => {
    expect(formatTemp(45.5, "f")).toBe("113.9 °F");
  });

  test("undefined stays undefined — a missing sensor is not 32 °F", () => {
    expect(formatTemp(undefined, "c")).toBeUndefined();
    expect(formatTemp(undefined, "f")).toBeUndefined();
  });

  test("a non-finite reading is treated as no reading at all", () => {
    expect(formatTemp(Number.NaN, "c")).toBeUndefined();
    expect(formatTemp(Number.POSITIVE_INFINITY, "f")).toBeUndefined();
  });

  test("zero is a real reading, not a missing one", () => {
    expect(formatTemp(0, "c")).toBe("0.0 °C");
    expect(formatTemp(0, "f")).toBe("32.0 °F");
  });
});

describe("parseTempUnit", () => {
  test("only an explicit f selects fahrenheit", () => {
    expect(parseTempUnit("f")).toBe("f");
  });

  test("anything unrecognised falls back to celsius", () => {
    const junk: unknown[] = ["F", "fahrenheit", "", null, undefined, 1, {}];
    for (const value of junk) expect(parseTempUnit(value)).toBe("c");
  });

  test("the fallback is assignable as a TempUnit", () => {
    const unit: TempUnit = parseTempUnit(null);
    expect(unit).toBe("c");
  });
});
