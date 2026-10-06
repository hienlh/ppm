import { describe, expect, test } from "bun:test";
import { createPatch } from "diff";
import { reverseUnifiedDiff } from "../../../src/services/session-file-baselines/reverse-unified-diff.ts";

/** A unified diff in codex's shape: hunks only, one line of context, no file headers. */
function codexDiff(before: string, after: string): string {
  const patch = createPatch("f", before, after, "", "", { context: 1 });
  return patch.slice(patch.indexOf("@@"));
}

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe("reverseUnifiedDiff", () => {
  test("undoes the update codex recorded for a real file", () => {
    const before = "intro\n\n**Viewer:** toolbar Home, Back, Screenshot, Disconnect\nend\n";
    const after = "intro\n\n**Viewer:** toolbar Home, Back, Disconnect\nend\n";
    const diff = [
      "@@ -2,3 +2,3 @@",
      " ",
      "-**Viewer:** toolbar Home, Back, Screenshot, Disconnect",
      "+**Viewer:** toolbar Home, Back, Disconnect",
      " end",
      "",
    ].join("\n");
    expect(reverseUnifiedDiff(after, diff)).toBe(before);
  });

  test("undoes edits at the start, the middle and the end in one diff", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n") + "\n";
    const after = ["A", "a", "b", "c", "D", "e", "f", "g", "h", "i"].join("\n") + "\n";
    expect(reverseUnifiedDiff(after, codexDiff(before, after))).toBe(before);
  });

  test("keeps each side's missing newline at the end of the file", () => {
    for (const [before, after] of [
      ["one\ntwo", "one\nTWO"],
      ["one\ntwo\n", "one\ntwo"],
      ["one\ntwo", "one\ntwo\n"],
      ["", "now there is text\n"],
      ["all of it goes\n", ""],
    ]) {
      expect(reverseUnifiedDiff(after!, codexDiff(before!, after!))).toBe(before!);
    }
  });

  test("keeps carriage returns", () => {
    const before = "a\r\nb\r\nc\r\n";
    const after = "a\r\nB\r\nc\r\n";
    expect(reverseUnifiedDiff(after, codexDiff(before, after))).toBe(before);
  });

  test("round-trips random edits", () => {
    const rand = rng(7);
    for (let n = 0; n < 300; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 30) }, (_, i) => (rand() < 0.15 ? "" : `line ${i}`));
      const before = lines.join("\n") + (rand() < 0.8 ? "\n" : "");
      const edited = [...lines];
      for (let k = Math.floor(rand() * 5); k >= 0; k--) {
        const at = Math.floor(rand() * (edited.length + 1));
        const roll = rand();
        if (roll < 0.33) edited.splice(at, 0, `inserted ${n}.${k}`);
        else if (roll < 0.66) edited.splice(at, 1);
        else edited.splice(at, 1, `replaced ${n}.${k}`);
      }
      const after = edited.join("\n") + (rand() < 0.8 ? "\n" : "");
      if (after === before) continue;
      expect(reverseUnifiedDiff(after, codexDiff(before, after))).toBe(before);
    }
  });

  test("refuses when the file no longer matches what the diff produced", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB\nc\n";
    const diff = codexDiff(before, after);
    expect(reverseUnifiedDiff("a\nB, edited again\nc\n", diff)).toBeNull();
    expect(reverseUnifiedDiff("", diff)).toBeNull();
  });

  test("refuses something that is not a unified diff", () => {
    expect(reverseUnifiedDiff("a\n", "")).toBeNull();
    expect(reverseUnifiedDiff("a\n", "just the new file content\n")).toBeNull();
    expect(reverseUnifiedDiff("a\n", "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: /x\n")).toBeNull();
  });
});
