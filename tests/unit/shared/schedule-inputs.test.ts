import { describe, it, expect } from "bun:test";
import {
  coerceInputValue,
  inputValueProblems,
  missingRequiredInputs,
  resolveInputValues,
} from "../../../src/shared/schedule-inputs.ts";
import type { ScheduleInputDecl } from "../../../src/types/scheduler.ts";

const decls: ScheduleInputDecl[] = [
  { key: "channel", label: "Channel", type: "text", required: true },
  { key: "poll", label: "Poll", type: "number", default: 45 },
  { key: "dryRun", label: "Dry run", type: "boolean", default: true },
  { key: "token", label: "Token", type: "secret", required: true },
];

describe("inputValueProblems", () => {
  it("accepts values of the declared types, and null to clear one", () => {
    expect(inputValueProblems(decls, { channel: "C1", poll: 30, dryRun: false }, { token: "xoxp" })).toEqual([]);
    expect(inputValueProblems(decls, { poll: null }, { token: null })).toEqual([]);
  });

  it("refuses unknown inputs, wrong types, and secrets passed as ordinary values", () => {
    expect(inputValueProblems(decls, { nope: 1 })).toEqual(['No input named "nope"']);
    expect(inputValueProblems(decls, { poll: "30" })).toEqual(['"poll" must be number']);
    expect(inputValueProblems(decls, { token: "xoxp" })).toEqual(['"token" is a secret; set it as a secret']);
    expect(inputValueProblems(decls, {}, { channel: "C1" })).toEqual(['"channel" is not a secret']);
    expect(inputValueProblems(decls, {}, { token: "" })).toEqual(['The secret "token" must be non-empty text']);
  });

  it("never quotes a secret's value back", () => {
    const problems = inputValueProblems(decls, {}, { token: 42 as never }).join(" ");
    expect(problems).not.toContain("42");
  });
});

describe("coerceInputValue", () => {
  it("reads command-line text as the declared type", () => {
    expect(coerceInputValue(decls[1]!, "30")).toBe(30);
    expect(coerceInputValue(decls[2]!, "no")).toBe(false);
    expect(coerceInputValue(decls[2]!, "true")).toBe(true);
    expect(coerceInputValue(decls[0]!, " C1 ")).toBe(" C1 ");
    expect(coerceInputValue(decls[1]!, "")).toBeInstanceOf(Error);
    expect(coerceInputValue(decls[2]!, "maybe")).toBeInstanceOf(Error);
  });
});

describe("missingRequiredInputs", () => {
  it("lists required inputs with no value, no default and, for a secret, nothing saved", () => {
    expect(missingRequiredInputs(decls, {}, [])).toEqual(["channel", "token"]);
    expect(missingRequiredInputs(decls, { channel: "C1" }, ["token"])).toEqual([]);
    const withDefault: ScheduleInputDecl[] = [{ key: "x", label: "X", type: "text", required: true, default: "d" }];
    expect(missingRequiredInputs(withDefault, {}, [])).toEqual([]);
  });
});

describe("resolveInputValues", () => {
  it("gives the value, else the default, else undefined; secrets come from the secret store", () => {
    expect(resolveInputValues(decls, { channel: "C1" }, { token: "xoxp" })).toEqual({
      channel: "C1", poll: 45, dryRun: true, token: "xoxp",
    });
    expect(resolveInputValues(decls, {}, {}).token).toBeUndefined();
  });
});
