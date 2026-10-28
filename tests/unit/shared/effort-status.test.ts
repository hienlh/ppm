import { describe, expect, it } from "bun:test";
import { effortEnvMeaning, effortInEffect, effortSettingPlace, type EffortStatus } from "../../../src/shared/effort-status.ts";

describe("effortEnvMeaning", () => {
  it("reads CLAUDE_CODE_EFFORT_LEVEL the way the CLI does", () => {
    expect(effortEnvMeaning("max")).toEqual({ kind: "level", level: "max" });
    expect(effortEnvMeaning("MAX")).toEqual({ kind: "level", level: "max" });
    expect(effortEnvMeaning("med")).toEqual({ kind: "level", level: "medium" });
    expect(effortEnvMeaning("auto")).toEqual({ kind: "auto" });
    expect(effortEnvMeaning("Unset")).toEqual({ kind: "auto" });
    expect(effortEnvMeaning("32000")).toEqual({ kind: "budget" });
  });

  it("ignores what the CLI ignores", () => {
    // "extra" is PPM's label for xhigh, not a value the CLI knows.
    expect(effortEnvMeaning("extra")).toBeNull();
    expect(effortEnvMeaning("")).toBeNull();
    expect(effortEnvMeaning(undefined)).toBeNull();
  });
});

describe("effortInEffect", () => {
  it("is the pick when nothing is known or nothing overrides it", () => {
    expect(effortInEffect("high", null)).toEqual({ level: "high", reason: null });
    expect(effortInEffect("high", {})).toEqual({ level: "high", reason: null });
    expect(effortInEffect("low", { observed: { requested: "low", applied: "low" } })).toEqual({ level: "low", reason: null });
  });

  it("follows CLAUDE_CODE_EFFORT_LEVEL whatever is picked", () => {
    // What the real CLI answered with `"env": { "CLAUDE_CODE_EFFORT_LEVEL": "max" }` in the user settings.
    const status: EffortStatus = {
      env: { value: "max", source: "userSettings" },
      observed: { requested: "high", applied: "max", model: "claude-opus-5-5[1m]" },
    };
    expect(effortInEffect("high", status)).toEqual({ level: "max", reason: "env" });
    // A pick made since changes nothing: the variable still decides.
    expect(effortInEffect("low", status)).toEqual({ level: "max", reason: "env" });
    // Even one that happens to match, so the picker never looks in control.
    expect(effortInEffect("max", status)).toEqual({ level: "max", reason: "env" });
  });

  it("works the variable out from the settings alone before a CLI has answered", () => {
    expect(effortInEffect("high", { env: { value: "low", source: "environment" } })).toEqual({ level: "low", reason: "env" });
    expect(effortInEffect("high", { env: { value: "max", source: "userSettings" }, cap: { value: "xhigh", source: "projectSettings" } }))
      .toEqual({ level: "xhigh", reason: "env" });
    expect(effortInEffect("high", { env: { value: "auto", source: "userSettings" } })).toEqual({ level: null, reason: "env" });
    expect(effortInEffect("high", { env: { value: "32000", source: "userSettings" } })).toEqual({ level: null, reason: "env" });
  });

  it("reads auto and a number under a cap the way the CLI does", () => {
    // Measured on the CLI: auto under a "low" cap sends low. A number under a cap is read as High
    // (the CLI's own code), then clamped.
    expect(effortInEffect("high", { env: { value: "auto", source: "userSettings" }, cap: { value: "low", source: "userSettings" } }))
      .toEqual({ level: "low", reason: "env" });
    expect(effortInEffect("low", { env: { value: "32000", source: "environment" }, cap: { value: "medium", source: "userSettings" } }))
      .toEqual({ level: "medium", reason: "env" });
    expect(effortInEffect("low", { env: { value: "32000", source: "environment" }, cap: { value: "xhigh", source: "userSettings" } }))
      .toEqual({ level: "high", reason: "env" });
  });

  it("clamps to a settings cap, for a pick made before or after the CLI answered", () => {
    const cap: EffortStatus["cap"] = { value: "high", source: "userSettings" };
    expect(effortInEffect("max", { cap, observed: { requested: "max", applied: "high" } })).toEqual({ level: "high", reason: "cap" });
    expect(effortInEffect("xhigh", { cap, observed: { requested: "max", applied: "high" } })).toEqual({ level: "high", reason: "cap" });
    expect(effortInEffect("medium", { cap, observed: { requested: "max", applied: "high" } })).toEqual({ level: "medium", reason: null });
  });

  it("runs Extra and Max as High on a model without them, and sends nothing to one without effort", () => {
    const opus45: EffortStatus = { supported: ["low", "medium", "high"], observed: { requested: "max", applied: "high", model: "claude-opus-4-5" } };
    expect(effortInEffect("max", opus45)).toEqual({ level: "high", reason: "model" });
    expect(effortInEffect("xhigh", opus45)).toEqual({ level: "high", reason: "model" });
    expect(effortInEffect("low", opus45)).toEqual({ level: "low", reason: null });
    const haiku: EffortStatus = { supported: [], observed: { requested: "high", applied: null, model: "claude-haiku-4-5-20251001" } };
    expect(effortInEffect("high", haiku)).toEqual({ level: null, reason: "model" });
    expect(effortInEffect("low", haiku)).toEqual({ level: null, reason: "model" });
  });

  it("trusts the CLI over what it can work out for a limit only the CLI knows", () => {
    // An organization's cap is not in any settings file the CLI reports.
    expect(effortInEffect("max", { observed: { requested: "max", applied: "medium" } })).toEqual({ level: "medium", reason: "model" });
  });
});

describe("effortSettingPlace", () => {
  it("names the file to edit", () => {
    expect(effortSettingPlace({ value: "max", source: "userSettings" })).toBe("~/.claude/settings.json");
    expect(effortSettingPlace({ value: "max", source: "userSettings", file: "/etc/claude/settings.json" })).toBe("/etc/claude/settings.json");
    expect(effortSettingPlace({ value: "max", source: "localSettings" })).toBe(".claude/settings.local.json");
    expect(effortSettingPlace({ value: "max", source: "environment" })).toBe("the environment PPM runs in");
  });
});
