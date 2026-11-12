/**
 * The editor's change bars, as computed: which lines of the buffer are added,
 * modified, or sit next to deleted lines, against the file in the index.
 */
import { describe, expect, it } from "bun:test";
import { computeGutterChanges, splitBaseLines } from "../../../src/web/lib/gutter-changes";

const lines = (text: string) => splitBaseLines(text);

describe("splitBaseLines", () => {
  it("splits as Monaco does, a final newline leaving an empty last line", () => {
    expect(lines("a\nb\n")).toEqual(["a", "b", ""]);
    expect(lines("a\r\nb")).toEqual(["a", "b"]);
    expect(lines("a\rb")).toEqual(["a", "b"]);
    expect(lines("")).toEqual([""]);
  });

  it("drops a byte-order mark, which Monaco keeps out of the model", () => {
    expect(lines("﻿a\nb")).toEqual(["a", "b"]);
  });
});

describe("computeGutterChanges", () => {
  it("reports nothing for an unchanged buffer", () => {
    expect(computeGutterChanges(lines("a\nb\nc\n"), lines("a\nb\nc\n"))).toEqual([]);
  });

  it("marks added lines", () => {
    expect(computeGutterChanges(lines("a\nb\n"), lines("a\nx\ny\nb\n"))).toEqual([
      { kind: "added", startLine: 2, endLine: 3 },
    ]);
  });

  it("marks lines appended at the end", () => {
    expect(computeGutterChanges(lines("a\n"), lines("a\nb\n"))).toEqual([
      { kind: "added", startLine: 2, endLine: 2 },
    ]);
  });

  it("marks a changed line as modified", () => {
    expect(computeGutterChanges(lines("a\nb\nc\n"), lines("a\nB\nc\n"))).toEqual([
      { kind: "modified", startLine: 2, endLine: 2 },
    ]);
  });

  it("marks only the new range of a modification that shrank or grew", () => {
    expect(computeGutterChanges(lines("a\nb\nc\nd\n"), lines("a\nX\nd\n"))).toEqual([
      { kind: "modified", startLine: 2, endLine: 2 },
    ]);
    expect(computeGutterChanges(lines("a\nb\nd\n"), lines("a\nX\nY\nZ\nd\n"))).toEqual([
      { kind: "modified", startLine: 2, endLine: 4 },
    ]);
  });

  it("puts a deletion on the line the deleted lines followed", () => {
    expect(computeGutterChanges(lines("a\nb\nc\nd\n"), lines("a\nd\n"))).toEqual([
      { kind: "deleted", startLine: 1, endLine: 1 },
    ]);
  });

  it("reports a deletion at the top of the file as line 0", () => {
    expect(computeGutterChanges(lines("a\nb\nc\n"), lines("c\n"))).toEqual([
      { kind: "deleted", startLine: 0, endLine: 0 },
    ]);
  });

  it("keeps separate changes separate", () => {
    const base = lines("1\n2\n3\n4\n5\n6\n7\n8\n");
    const now = lines("1\nX\n3\n4\nnew\n5\n6\n8\n");
    expect(computeGutterChanges(base, now)).toEqual([
      { kind: "modified", startLine: 2, endLine: 2 },
      { kind: "added", startLine: 5, endLine: 5 },
      { kind: "deleted", startLine: 7, endLine: 7 },
    ]);
  });

  it("ignores line endings, so a CRLF base matches the same text with LF", () => {
    expect(computeGutterChanges(lines("a\r\nb\r\n"), lines("a\nb\n"))).toEqual([]);
  });

  it("matches the screenshot case: one line edited, one added", () => {
    const base = lines([
      'export function resolveEntryMode(',
      '  argv: string[],',
      '): "supervise" | "search" | "cli" {',
      '  if (argv.includes("__search__")) return "search";',
      '  return "cli";',
      '}',
    ].join("\n"));
    const now = lines([
      'export function resolveEntryMode(',
      '  argv: string[],',
      '): "supervise" | "search" | "memory" | "cli" {',
      '  if (argv.includes("__search__")) return "search";',
      '  if (argv.includes("__memory__")) return "memory";',
      '  return "cli";',
      '}',
    ].join("\n"));
    expect(computeGutterChanges(base, now)).toEqual([
      { kind: "modified", startLine: 3, endLine: 3 },
      { kind: "added", startLine: 5, endLine: 5 },
    ]);
  });

  it("reports a middle it cannot diff in time as one modified range, never as unchecked lines", () => {
    // Two unrelated 3000-line files share nothing: every line differs, and a 0 ms budget
    // cannot finish. The answer covers exactly the differing middle.
    const base = ["same-head", ...Array.from({ length: 3000 }, (_, i) => `old ${i}`), "same-tail"];
    const now = ["same-head", ...Array.from({ length: 2000 }, (_, i) => `new ${i}`), "same-tail"];
    expect(computeGutterChanges(base, now, 0)).toEqual([
      { kind: "modified", startLine: 2, endLine: 2001 },
    ]);
  });
});
