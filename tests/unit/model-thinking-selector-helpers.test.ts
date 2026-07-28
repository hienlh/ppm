import { describe, it, expect } from "bun:test";
import {
  EFFORT_OPTIONS,
  effortLabel,
  chipLabel,
} from "../../src/web/components/chat/model-thinking-selector-helpers.ts";

describe("effort options", () => {
  it("maps UI 'Extra' to SDK value 'xhigh' and never uses 'extra'", () => {
    const extra = EFFORT_OPTIONS.find((o) => o.label === "Extra");
    expect(extra?.value).toBe("xhigh");
    expect(EFFORT_OPTIONS.some((o) => o.value === "extra")).toBe(false);
  });

  it("has exactly the 5 SDK effort values in order", () => {
    expect(EFFORT_OPTIONS.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("marks High as the default", () => {
    expect(EFFORT_OPTIONS.find((o) => o.default)?.value).toBe("high");
  });
});

describe("effortLabel", () => {
  it("returns the UI label for a value", () => {
    expect(effortLabel("xhigh")).toBe("Extra");
    expect(effortLabel("high")).toBe("High");
    expect(effortLabel("max")).toBe("Max");
  });

  it("falls back to the raw value when unknown", () => {
    expect(effortLabel("mystery")).toBe("mystery");
  });
});

describe("chipLabel", () => {
  it("combines model display + effort label", () => {
    expect(chipLabel("Opus 5", "high")).toBe("Opus 5 · High");
    expect(chipLabel("Opus 5", "xhigh")).toBe("Opus 5 · Extra");
  });

  it("shows model only when effort is null", () => {
    expect(chipLabel("Opus 5", null)).toBe("Opus 5");
  });
});
