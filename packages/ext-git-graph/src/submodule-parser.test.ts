import { describe, it, expect } from "bun:test";
import { describeSubmoduleState, parseSubmoduleStatus } from "./submodule-parser.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("parseSubmoduleStatus", () => {
  it("decodes the leading state character", () => {
    const out = parseSubmoduleStatus([
      ` ${A} libs/current (v1.2.0)`,
      `-${A} libs/absent`,
      `+${B} libs/drifted (heads/main)`,
      `U${A} libs/conflicted`,
    ].join("\n"));

    expect(out.map((s) => s.state)).toEqual([
      "current", "uninitialized", "modified", "conflicted",
    ]);
  });

  it("reads the path and the recorded sha", () => {
    const [only] = parseSubmoduleStatus(` ${A} libs/parser (v1.2.0-3-gc0ffee)`);

    expect(only).toEqual({
      path: "libs/parser",
      hash: A,
      state: "current",
      describe: "v1.2.0-3-gc0ffee",
    });
  });

  it("keeps a path that contains spaces whole", () => {
    // The describe suffix is what makes this ambiguous; it is stripped from the
    // end, so everything before it belongs to the path.
    const [only] = parseSubmoduleStatus(` ${A} vendor/some lib (v1.0)`);

    expect(only!.path).toBe("vendor/some lib");
    expect(only!.describe).toBe("v1.0");
  });

  it("leaves describe unset when git printed none", () => {
    const [only] = parseSubmoduleStatus(`-${A} libs/absent`);

    expect(only!.describe).toBeUndefined();
  });

  it("keeps parentheses inside a describe string", () => {
    const [only] = parseSubmoduleStatus(` ${A} libs/parser (heads/feature/x)`);

    expect(only!.describe).toBe("heads/feature/x");
  });

  it("tolerates CRLF line endings", () => {
    expect(parseSubmoduleStatus(` ${A} libs/a\r\n ${B} libs/b\r\n`)).toHaveLength(2);
  });

  it("skips a line it cannot read rather than inventing a path", () => {
    const out = parseSubmoduleStatus([
      "fatal: not a git repository",
      ` ${A} libs/parser`,
    ].join("\n"));

    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("libs/parser");
  });

  it("returns nothing for a repository with no submodules", () => {
    expect(parseSubmoduleStatus("")).toEqual([]);
  });
});

describe("describeSubmoduleState", () => {
  it("says what each state means", () => {
    expect(describeSubmoduleState("current")).toBe("up to date");
    expect(describeSubmoduleState("uninitialized")).toBe("not checked out");
    expect(describeSubmoduleState("modified")).toBe("differs from the recorded commit");
    expect(describeSubmoduleState("conflicted")).toBe("has merge conflicts");
  });
});
