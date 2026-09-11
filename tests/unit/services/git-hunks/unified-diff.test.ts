import { describe, it, expect } from "bun:test";
import {
  buildPatch,
  parseUnifiedDiff,
  selectAll,
  selectionFromRequest,
} from "../../../../src/services/git-hunks/unified-diff.ts";

const HEADER = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
];

/** A diff with two hunks, each mixing an addition and a deletion. */
const TWO_HUNKS = [
  ...HEADER,
  "@@ -1,3 +1,4 @@ function a()",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 20;",
  "+const b2 = 21;",
  " const c = 3;",
  "@@ -10,3 +11,4 @@ function b()",
  " const x = 1;",
  "-const y = 2;",
  "+const y = 20;",
  "+const z = 30;",
  " const w = 4;",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("splits the header from the hunks", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    expect(parsed.header).toEqual(HEADER);
    expect(parsed.hunks).toHaveLength(2);
  });

  it("reads the ranges and the function heading", () => {
    const [first, second] = parseUnifiedDiff(TWO_HUNKS).hunks;

    expect(first).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, heading: "function a()" });
    expect(second).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 11, newLines: 4, heading: "function b()" });
  });

  it("classifies each line", () => {
    const [first] = parseUnifiedDiff(TWO_HUNKS).hunks;

    expect(first!.lines.map((l) => l.kind)).toEqual([" ", "-", "+", "+", " "]);
    expect(first!.lines[2]!.text).toBe("const b = 20;");
  });

  it("treats a missing count as 1, the way git writes a single-line range", () => {
    const diff = [...HEADER, "@@ -5 +5 @@", "-old", "+new", ""].join("\n");

    expect(parseUnifiedDiff(diff).hunks[0]).toMatchObject({
      oldStart: 5, oldLines: 1, newStart: 5, newLines: 1,
    });
  });

  it("attaches a no-newline marker to the line it follows", () => {
    const diff = [...HEADER, "@@ -1,2 +1,2 @@", " keep", "-old", "\\ No newline at end of file", "+new", ""].join("\n");

    const lines = parseUnifiedDiff(diff).hunks[0]!.lines;

    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ kind: "-", text: "old", noNewline: true });
    expect(lines[2]!.noNewline).toBeUndefined();
  });

  it("keeps an empty context line", () => {
    const diff = [...HEADER, "@@ -1,3 +1,3 @@", " a", "", "-b", "+c", ""].join("\n");

    expect(parseUnifiedDiff(diff).hunks[0]!.lines.map((l) => l.kind)).toEqual([" ", " ", "-", "+"]);
  });

  it("flags a binary diff", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff).binary).toBe(true);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual({ header: [], hunks: [], binary: false });
  });
});

describe("buildPatch — whole hunks", () => {
  it("reproduces the diff when every hunk is selected", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    expect(buildPatch(parsed, selectAll(parsed))).toBe(TWO_HUNKS);
  });

  it("keeps only the chosen hunk, and renumbers the new side", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    const patch = buildPatch(parsed, new Map([[1, "all" as const]]));

    // The first hunk is left out, so the second no longer shifts by it: its new
    // side starts where its old side does.
    expect(patch).toBe([
      ...HEADER,
      "@@ -10,3 +10,4 @@ function b()",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 20;",
      "+const z = 30;",
      " const w = 4;",
      "",
    ].join("\n"));
  });

  it("offsets a later hunk by the size change of an earlier one", () => {
    const diff = [
      ...HEADER,
      "@@ -1,2 +1,3 @@",
      " a",
      "+added",
      " b",
      "@@ -10,2 +11,3 @@",
      " x",
      "+y",
      " z",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);

    const patch = buildPatch(parsed, selectAll(parsed));

    // First hunk grows the file by one line, so the second starts at 11.
    expect(patch).toContain("@@ -10,2 +11,3 @@");
  });

  it("returns null when nothing is selected", () => {
    expect(buildPatch(parseUnifiedDiff(TWO_HUNKS), new Map())).toBeNull();
  });

  it("refuses a binary diff", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n"));

    expect(() => buildPatch(parsed, selectAll(parsed))).toThrow(/binary/i);
  });
});

describe("buildPatch — individual lines", () => {
  it("drops an unselected addition", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    // Hunk 1 lines: 0=" ", 1="-", 2="+ y=20", 3="+ z=30", 4=" "
    const patch = buildPatch(parsed, new Map([[1, new Set([1, 2])]]));

    expect(patch).toContain("+const y = 20;");
    expect(patch).not.toContain("+const z = 30;");
  });

  it("keeps an unselected deletion as context so the patch still applies", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    // Take only the addition, not the deletion it replaces.
    const patch = buildPatch(parsed, new Map([[0, new Set([2])]]));

    // The deleted line must remain, as context — dropping it entirely would
    // describe a file that never existed.
    expect(patch).toContain(" const b = 2;");
    expect(patch).not.toContain("-const b = 2;");
    expect(patch).toContain("+const b = 20;");
  });

  it("recomputes the counts after narrowing a hunk", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    const patch = buildPatch(parsed, new Map([[0, new Set([2])]]));

    // 3 old lines (2 context + the now-context deletion), 4 new.
    expect(patch).toContain("@@ -1,3 +1,4 @@ function a()");
  });

  it("skips a hunk whose selection leaves only context", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    // Selecting no changed line in hunk 0 leaves it a no-op.
    expect(buildPatch(parsed, new Map([[0, new Set<number>()]]))).toBeNull();
  });
});

describe("buildPatch — reverse", () => {
  it("keeps an unselected addition as context when reversing", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    // Unstaging only the deletion out of hunk 1.
    const patch = buildPatch(parsed, new Map([[1, new Set([1])]]), { reverse: true });

    // Reversed, the source file is the *new* side: an addition we are not
    // reverting is already present, so it is context.
    expect(patch).toContain(" const y = 20;");
    expect(patch).toContain(" const z = 30;");
    expect(patch).toContain("-const y = 2;");
  });

  it("drops an unselected deletion when reversing", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    const patch = buildPatch(parsed, new Map([[0, new Set([2])]]), { reverse: true });

    expect(patch).toContain("+const b = 20;");
    expect(patch).not.toContain("const b = 2;\n");
  });
});

describe("selectionFromRequest", () => {
  it("takes a hunk whole when no lines are given", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    expect(selectionFromRequest(parsed, [{ hunk: 0 }]).get(0)).toBe("all");
  });

  it("narrows a hunk to the given lines", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    expect(selectionFromRequest(parsed, [{ hunk: 0, lines: [1, 2] }]).get(0)).toEqual(new Set([1, 2]));
  });

  it("refuses a hunk index that does not exist", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    expect(() => selectionFromRequest(parsed, [{ hunk: 5 }])).toThrow(/No hunk at index 5/);
  });

  it("refuses a line index outside the hunk", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    expect(() => selectionFromRequest(parsed, [{ hunk: 0, lines: [99] }])).toThrow(/No line at index 99/);
  });

  it("refuses a non-integer index rather than coercing it", () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);

    expect(() => selectionFromRequest(parsed, [{ hunk: 1.5 }])).toThrow(/No hunk at index/);
  });
});
