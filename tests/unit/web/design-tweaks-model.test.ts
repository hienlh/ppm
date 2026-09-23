import { describe, expect, it } from "bun:test";
import {
  buildAddTweaksPrompt, buildFixTweaksPrompt, hexForColorInput, overriddenVars, pendingChanges, rangeNumberOf,
  sameTweakValue, shownValue,
} from "../../../src/web/lib/design/design-tweaks-model.ts";
import { parseTweaks, type RangeTweak } from "../../../src/shared/design-tweaks.ts";

const { tweaks } = parseTweaks([
  { id: "r", label: "Radius", type: "range", var: "--radius", min: 0, max: 32, step: 1, unit: "px", default: 12 },
  { id: "c", label: "Accent", type: "color", var: "--accent", default: "#6366f1" },
  { id: "s", label: "Font", type: "select", var: "--font", options: [{ label: "Sans", value: "Inter, sans-serif" }], default: "Inter, sans-serif" },
]);
const [range, color, select] = tweaks as [RangeTweak, (typeof tweaks)[number], (typeof tweaks)[number]];

describe("design tweaks model", () => {
  it("compares rendered values loosely on case and spacing only", () => {
    expect(sameTweakValue("#ABCDEF", " #abcdef ")).toBe(true);
    expect(sameTweakValue("Inter,  sans-serif", "inter, sans-serif")).toBe(true);
    expect(sameTweakValue("12px", "13px")).toBe(false);
  });

  it("keeps only edits that differ from the page and that the server would accept", () => {
    const edits = { "--radius": "12px", "--accent": "#000000", "--font": "Comic Sans", "--other": "1px" };
    const rendered = { "--radius": "12px", "--accent": "#6366f1" };
    expect(pendingChanges(tweaks, edits, rendered)).toEqual({ "--accent": "#000000" });
  });

  it("flags committed values the reloaded page does not render", () => {
    expect(overriddenVars({ "--accent": "#000000", "--radius": "4px" }, { "--accent": "#000000", "--radius": "8px" })).toEqual(["--radius"]);
  });

  it("shows the edit, else the rendered value, else the default", () => {
    expect(shownValue(range, { "--radius": "3px" }, { "--radius": "8px" })).toBe("3px");
    expect(shownValue(range, {}, { "--radius": "8px" })).toBe("8px");
    expect(shownValue(range, {}, { "--radius": "" })).toBe("12px");
    expect(shownValue(color, {}, {})).toBe("#6366f1");
    expect(shownValue(select, {}, {})).toBe("Inter, sans-serif");
  });

  it("turns any rendered colour into something <input type=color> accepts", () => {
    expect(hexForColorInput("#ABC", "#000000")).toBe("#aabbcc");
    expect(hexForColorInput("#11223344", "#000000")).toBe("#112233");
    expect(hexForColorInput("rebeccapurple", "#6366f1")).toBe("#6366f1");
    expect(hexForColorInput("nope", "nope")).toBe("#000000");
  });

  it("places the slider from a rendered value, clamped, or the default when unparseable", () => {
    expect(rangeNumberOf(range, "8px")).toBe(8);
    expect(rangeNumberOf(range, "99px")).toBe(32);
    expect(rangeNumberOf(range, "calc(1px + 2px)")).toBe(12);
  });

  it("builds chat briefs that name the design's own files", () => {
    expect(buildAddTweaksPrompt("home")).toContain("designs/home/design.json");
    const fix = buildFixTweaksPrompt("home", ['"x": needs a label']);
    expect(fix).toContain("designs/home/design.json");
    expect(fix).toContain('- "x": needs a label');
  });
});
