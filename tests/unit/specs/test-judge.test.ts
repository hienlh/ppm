import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeRun, newFailures } from "../../../src/services/specs/test-judge.ts";

const DIR = join(import.meta.dir, "../../fixtures/spec-runner-output");

function sample(name: string, command: string) {
  const text = readFileSync(join(DIR, `${name}.txt`), "utf8");
  const m = text.match(/\nexit=(\d+)\s*$/);
  const output = text.slice(0, m ? m.index : undefined);
  return judgeRun({ command, output, code: m ? Number(m[1]) : null, timedOut: false });
}

describe("judgeRun", () => {
  it("bun: assertion failures are a real red, with the failing names", () => {
    const v = sample("bun-assert", "bun test tests/x.test.ts");
    expect(v.runner).toBe("bun");
    expect(v.outcome).toBe("fail");
    expect(v.failing).toEqual(["html export > inlines images", "html export > lists unreadable images"]);
    expect(v.passed).toBe(1);
    expect(v.failed).toBe(2);
    expect(v.weak).toBe(false);
  });

  it("bun: a test that throws still ran, so it counts as red", () => {
    expect(sample("bun-throws", "bun test").outcome).toBe("fail");
  });

  it("bun: a missing module or a syntax error is broken, not red", () => {
    expect(sample("bun-missing", "bun test").outcome).toBe("broken");
    expect(sample("bun-syntax", "bun test").outcome).toBe("broken");
  });

  it("bun: zero tests is empty, and a pass is a pass", () => {
    expect(sample("bun-empty", "bun test").outcome).toBe("empty");
    expect(sample("bun-pass", "bun test").outcome).toBe("pass");
  });

  it("go: a failing test vs a build failure", () => {
    const v = sample("go-assert", "go test ./...");
    expect(v.runner).toBe("go");
    expect(v.outcome).toBe("fail");
    expect(v.failing).toEqual(["TestAdd"]);
    expect(sample("go-build", "go test ./...").outcome).toBe("broken");
    expect(sample("go-pass", "go test ./...").outcome).toBe("pass");
  });

  it("cargo: a panicking assertion vs a compile error", () => {
    const v = sample("cargo-assert", "cargo test");
    expect(v.outcome).toBe("fail");
    expect(v.failing).toEqual(["tests::adds"]);
    expect(sample("cargo-build", "cargo test").outcome).toBe("broken");
  });

  it("pytest: a failed assert vs a collection error", () => {
    const v = sample("pytest-assert", "pytest -q");
    expect(v.runner).toBe("pytest");
    expect(v.outcome).toBe("fail");
    expect(v.failing).toEqual(["tests/test_x.py::test_add"]);
    expect(sample("pytest-collect", "python -m pytest").outcome).toBe("broken");
    expect(sample("pytest-pass", "pytest").outcome).toBe("pass");
  });

  it("vitest and jest: a failed expect vs a suite that never loaded", () => {
    const vi = sample("vitest-assert", "npx vitest run");
    expect(vi.runner).toBe("vitest");
    expect(vi.outcome).toBe("fail");
    expect(vi.failing).toEqual(["src/x.test.ts > adds"]);
    expect(sample("vitest-load", "npx vitest run").outcome).toBe("broken");
    const je = sample("jest-assert", "npx jest");
    expect(je.runner).toBe("jest");
    expect(je.outcome).toBe("fail");
    expect(je.failing).toEqual(["math › adds"]);
    expect(sample("jest-suite", "npx jest").outcome).toBe("broken");
  });

  it("an unknown runner is judged by its exit code alone, and says so", () => {
    const fail = judgeRun({ command: "make check", output: "something went wrong", code: 2, timedOut: false });
    expect(fail.runner).toBe("generic");
    expect(fail.outcome).toBe("fail");
    expect(fail.weak).toBe(true);
    expect(judgeRun({ command: "make check", output: "", code: 0, timedOut: false }).outcome).toBe("pass");
  });

  it("a run that timed out or could not start is never red", () => {
    expect(judgeRun({ command: "bun test", output: "", code: null, timedOut: true }).outcome).toBe("timeout");
    expect(judgeRun({ command: "nope", output: "Executable not found", code: null, timedOut: false }).outcome).toBe("broken");
  });
});

describe("newFailures", () => {
  it("lists failures the baseline did not have", () => {
    expect(newFailures(["a", "b", "c"], ["b", "x"])).toEqual(["a", "c"]);
  });
});
