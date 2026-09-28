import { describe, expect, it } from "bun:test";
import {
  MAX_SELECT_OPTIONS, MAX_TWEAKS, TWEAK_SCHEMA_EXAMPLE, formatRangeValue, isSafeTweakFile, isSafeTweakValueShape,
  parseTweaks, sanitizeTweakValue, type TweakDef,
} from "../../../src/shared/design-tweaks.ts";
import { parseChildMessage, parseParentMessage } from "../../../src/shared/design-bridge-protocol.ts";
import { TWEAK_INJECTIONS as INJECTIONS } from "../../fixtures/design-tweak-injections.ts";

const range = { id: "r", label: "Radius", type: "range", var: "--radius", min: 0, max: 32, step: 1, unit: "px", default: 12 };
const color = { id: "c", label: "Accent", type: "color", var: "--accent", default: "#6366f1" };
const select = {
  id: "s", label: "Font", type: "select", var: "--font",
  options: [{ label: "Sans", value: "Inter, sans-serif" }, { label: "Serif", value: "Georgia, serif" }], default: "Inter, sans-serif",
};

describe("parseTweaks", () => {
  it("accepts every type and keeps optional fields", () => {
    const { tweaks, errors } = parseTweaks([range, color, { ...select, file: "styles.css" }]);
    expect(errors).toEqual([]);
    expect(tweaks.map((t) => t.type)).toEqual(["range", "color", "select"]);
    expect(tweaks[2]).toMatchObject({ file: "styles.css" });
    expect(tweaks[0]).toMatchObject({ min: 0, max: 32, step: 1, unit: "px", default: 12 });
  });

  it("treats a missing list as no tweaks and a non-array as one error", () => {
    expect(parseTweaks(undefined)).toEqual({ tweaks: [], errors: [] });
    expect(parseTweaks({})).toEqual({ tweaks: [], errors: ["tweaks must be an array"] });
  });

  it("skips invalid entries with a reason and keeps the valid ones", () => {
    const { tweaks, errors } = parseTweaks([
      range, "nope", { ...color, id: "bad id" }, { ...color, id: "c2", var: "accent" }, { ...color, id: "c3", var: "--x", default: "red" },
      { ...range, id: "r2", var: "--r2", min: 5, max: 5 }, { ...range, id: "r3", var: "--r3", step: 0 },
      { ...range, id: "r4", var: "--r4", unit: "vh" }, { ...range, id: "r5", var: "--r5", default: 99 },
      { ...select, id: "s2", var: "--s2", default: "Comic Sans" }, { ...select, id: "s3", var: "--s3", options: [] },
      { ...color, id: "t", var: "--t", type: "slider" }, { ...color, id: "l", var: "--l", label: "  " },
    ]);
    expect(tweaks.map((t) => t.id)).toEqual(["r"]);
    expect(errors).toHaveLength(12);
    expect(errors.join("\n")).toContain('"r5": default must be a number within min..max');
  });

  it("rejects duplicate ids and a var bound twice", () => {
    const { tweaks, errors } = parseTweaks([color, { ...color, var: "--other" }, { ...color, id: "c9" }]);
    expect(tweaks).toHaveLength(1);
    expect(errors).toEqual(['"c": duplicate id', '"c9": --accent is already bound to another tweak']);
  });

  it("enforces the limits", () => {
    const many = Array.from({ length: MAX_TWEAKS + 3 }, (_, i) => ({ ...color, id: `c${i}`, var: `--c${i}` }));
    const parsed = parseTweaks(many);
    expect(parsed.tweaks).toHaveLength(MAX_TWEAKS);
    expect(parsed.errors[0]).toContain(`first ${MAX_TWEAKS}`);
    const options = Array.from({ length: MAX_SELECT_OPTIONS + 1 }, (_, i) => ({ label: `o${i}`, value: `o${i}` }));
    expect(parseTweaks([{ ...select, options, default: "o0" }]).errors[0]).toContain("more than");
    expect(parseTweaks([{ ...color, var: `--${"a".repeat(49)}` }]).errors).toHaveLength(1);
    expect(parseTweaks([{ ...range, max: 1e7 }]).errors).toHaveLength(1);
  });

  it("confines file to the design folder", () => {
    for (const file of ["../tokens.css", "/etc/x.css", "C:/x.css", ".design/x.css", "a/../b.css", "dir\\x.css", "x.js", "./x.css"]) {
      expect(isSafeTweakFile(file)).toBe(false);
      expect(parseTweaks([{ ...color, file }]).tweaks).toHaveLength(0);
    }
    expect(isSafeTweakFile("css/theme.css")).toBe(true);
    expect(isSafeTweakFile("index.html")).toBe(true);
  });

  it("refuses a select option that is not plain CSS at parse time", () => {
    for (const value of INJECTIONS) {
      const { tweaks, errors } = parseTweaks([{ ...select, options: [...select.options, { label: "Evil", value }] }]);
      expect(tweaks).toHaveLength(0);
      expect(errors).toHaveLength(1);
    }
  });

  it("parses the example embedded in the instructions with zero errors", () => {
    const { tweaks, errors } = parseTweaks(JSON.parse(JSON.stringify(TWEAK_SCHEMA_EXAMPLE)).tweaks);
    expect(errors).toEqual([]);
    expect(tweaks.map((t) => t.type).sort()).toEqual(["color", "range", "select"]);
  });
});

describe("sanitizeTweakValue", () => {
  const [r, c, s] = parseTweaks([range, color, select]).tweaks as [TweakDef, TweakDef, TweakDef];

  it("accepts in-range values in the declared unit", () => {
    expect(sanitizeTweakValue(r, "0px")).toBe("0px");
    expect(sanitizeTweakValue(r, "12.5px")).toBe("12.5px");
    expect(sanitizeTweakValue(r, "32px")).toBe("32px");
    expect(formatRangeValue({ unit: "px" }, 1 / 3)).toBe("0.3333px");
  });

  it("rejects out-of-range, wrong-unit and malformed range values", () => {
    for (const v of ["33px", "-1px", "12", "12rem", "1e3px", "12 px", "12px;", "0x10px", 12]) {
      expect(sanitizeTweakValue(r, v)).toBeNull();
    }
  });

  it("accepts hex colours only", () => {
    for (const v of ["#abc", "#AABBCC", "#aabbcc80"]) expect(sanitizeTweakValue(c, v)).toBe(v);
    for (const v of ["red", "#abcd", "#ggg", "rgb(1,2,3)", "#abc;"]) expect(sanitizeTweakValue(c, v)).toBeNull();
  });

  it("accepts only a declared option", () => {
    expect(sanitizeTweakValue(s, "Georgia, serif")).toBe("Georgia, serif");
    expect(sanitizeTweakValue(s, "Arial")).toBeNull();
  });

  it("lets no injection string through for any type", () => {
    for (const v of INJECTIONS) {
      expect(isSafeTweakValueShape(v)).toBe(false);
      for (const def of [r, c, s]) expect(sanitizeTweakValue(def, v)).toBeNull();
    }
    expect(isSafeTweakValueShape("calc(100% - 2px)")).toBe(true);
    expect(isSafeTweakValueShape("rgb(1, 2, 3)")).toBe(true);
  });
});

describe("tweak bridge messages", () => {
  const env = { ppm: "design-bridge", v: 1, nonce: "abcdefghijklmnop" };

  it("validates tweak-set values and names", () => {
    expect(parseParentMessage({ ...env, type: "tweak-set", values: { "--a": "12px", "--b": "#fff" } }))
      .toEqual({ type: "tweak-set", values: { "--a": "12px", "--b": "#fff" } });
    for (const v of INJECTIONS) expect(parseParentMessage({ ...env, type: "tweak-set", values: { "--a": v } })).toBeNull();
    expect(parseParentMessage({ ...env, type: "tweak-set", values: { color: "red" } })).toBeNull();
  });

  it("validates reads, resets and the frame's answer", () => {
    expect(parseParentMessage({ ...env, type: "tweak-reset" })).toEqual({ type: "tweak-reset" });
    expect(parseParentMessage({ ...env, type: "tweak-reset", vars: ["--a"] })).toEqual({ type: "tweak-reset", vars: ["--a"] });
    expect(parseParentMessage({ ...env, type: "tweak-read", vars: ["x"] })).toBeNull();
    const answer = parseChildMessage({ ...env, type: "tweak-values", values: { "--a": " 12px" }, winners: { "--a": "root" } });
    expect(answer).toMatchObject({ type: "tweak-values", values: { "--a": " 12px" }, winners: { "--a": "root" } });
    expect(parseChildMessage({ ...env, type: "tweak-values", values: {}, winners: { "--a": "css" } })).toBeNull();
  });
});
