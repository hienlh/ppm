import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeLine, splitLines } from "../../../../../src/services/ppm-tasks/child-check/transcript-line-normalizer.ts";

const FIXTURE = resolve(import.meta.dir, "../../../../fixtures/ppm-tasks/benchmark-memory-wait.jsonl");

/** The 19 output lines of the benchmark wait loop, as the fixture's tool results carry them. */
function benchmarkLines(): string[] {
  return readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .flatMap((r) => r.message.content).filter((b: { type: string }) => b.type === "tool_result").map((b: { content: string }) => b.content);
}

describe("normalizeLine", () => {
  it("folds the benchmark's waiting lines into one form", () => {
    const lines = benchmarkLines();
    expect(lines).toHaveLength(19);
    const waiting = lines.filter((l) => l.includes("committed; waiting"));
    expect(waiting).toHaveLength(14);
    expect(new Set(waiting.map(normalizeLine))).toEqual(new Set(["<t> memory # committed; waiting"]));
  });

  it("gives the other benchmark lines forms of their own", () => {
    const forms = new Set(benchmarkLines().map(normalizeLine));
    // time budget (twice, same form), batch finished, quota, token, waiting.
    expect(forms.size).toBe(5);
    expect(forms).toContain("<t> token: present");
    expect(forms).toContain("<t> quota at <t>: five-hour #, weekly #");
    expect(forms).toContain("<t> time budget reached before t#-mobile-e-r#; ending batch between runs");
  });

  it("replaces timestamps, long hex and numbers; lowercases and collapses spaces", () => {
    expect(normalizeLine("2026-11-16T02:37:11.123Z  Build   OK in 1.5s")).toBe("<t> build ok in #s");
    expect(normalizeLine("sha256 50966c6c1cf9 installed")).toBe("sha# <h> installed");
    expect(normalizeLine("commit deadbeef12 pushed at 14:05")).toBe("commit <h> pushed at <t>");
    expect(normalizeLine("Downloading 45% (12/30)")).toBe(normalizeLine("Downloading 46% (13/30)"));
  });

  it("strips ANSI codes", () => {
    expect(normalizeLine("\u001b[32mPASS\u001b[0m 12 tests")).toBe("pass # tests");
  });

  it("has no form for empty, punctuation-only or spinner lines", () => {
    expect(normalizeLine("")).toBeNull();
    expect(normalizeLine("   ")).toBeNull();
    expect(normalizeLine("-----")).toBeNull();
    expect(normalizeLine("⠋")).toBeNull();
    expect(normalizeLine("...")).toBeNull();
  });

  it("caps a form at 200 characters", () => {
    expect(normalizeLine("x".repeat(500))!.length).toBe(200);
  });

  it("splits on \\r as well as \\n", () => {
    expect(splitLines("a\r b\r\nc\nd")).toEqual(["a", " b", "c", "d"]);
  });
});
