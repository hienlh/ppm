/**
 * Reading `git show` for the blame hover.
 *
 * The hunk header is the whole risk. git omits a count of one — `@@ -14,0 +15 @@`
 * rather than `+15,1` — so a parser that reads a missing count as zero makes
 * every single-line commit unmatchable, which is most of them. And the line
 * number involved is the line *at that commit*, not the line now, so an
 * off-by-one here attributes the wrong text to the right commit: wrong in a way
 * that still looks plausible.
 */
import { describe, it, expect } from "bun:test";
import { lineChangeAt, parseShow } from "../../../../src/services/git-blame/commit-line-diff.ts";

const NUL = String.fromCharCode(0);

/** The shape `--format=%H%x00%an%x00%ae%x00%at%x00%B%x00` produces. */
function show(message: string, diff = ""): string {
  return ["abc1234", "Ada", "ada@example.com", "1700000000", message + "\n"].join(NUL) + NUL + "\n" + diff;
}

describe("parseShow", () => {
  it("reads the five fields and the diff", () => {
    const result = parseShow(show("feat: a thing", "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"));

    expect(result).toMatchObject({
      hash: "abc1234",
      author: "Ada",
      authorMail: "ada@example.com",
      authorTime: 1700000000,
      message: "feat: a thing",
    });
    expect(result!.diff.startsWith("diff --git")).toBe(true);
  });

  it("keeps a multi-line message whole", () => {
    // The body is why the hover exists — the annotation already has the subject.
    const result = parseShow(show("subject\n\nbody line one\nbody line two"));

    expect(result!.message).toBe("subject\n\nbody line one\nbody line two");
  });

  it("keeps a message that contains the fields' own separator characters", () => {
    // A message with a `%` or a NUL-looking escape is still just text.
    const result = parseShow(show("fix: handle %x00 and %H in the log format"));

    expect(result!.message).toBe("fix: handle %x00 and %H in the log format");
  });

  it("is null when the format did not run", () => {
    // What a bad revision looks like on a git that still exits zero.
    expect(parseShow("")).toBeNull();
    expect(parseShow("some unrelated output\n")).toBeNull();
  });

  it("is null for an empty hash", () => {
    expect(parseShow([" ", "Ada", "a@b", "1", "m"].join(NUL) + NUL)).toBeNull();
  });

  it("reads a merge commit, which shows no diff", () => {
    const result = parseShow(show("Merge pull request #21"));

    expect(result!.message).toBe("Merge pull request #21");
    expect(result!.diff).toBe("");
  });

  it("survives a non-numeric timestamp", () => {
    const result = parseShow(["abc1234", "Ada", "a@b", "not-a-number", "m\n"].join(NUL) + NUL);

    expect(result!.authorTime).toBe(0);
  });
});

const MODIFIED = [
  "diff --git a/x.ts b/x.ts",
  "index 1111111..2222222 100644",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -14,0 +15 @@ import something",
  '+import { EDITOR_FONT_FAMILY } from "@/lib/editor-font";',
  "@@ -856 +857 @@ export const CodeEditor = memo(",
  '-              fontFamily: "Menlo, Monaco, Consolas, monospace",',
  "+              fontFamily: EDITOR_FONT_FAMILY,",
].join("\n");

describe("lineChangeAt", () => {
  it("finds a single-line addition whose count git omitted", () => {
    // `+15` with no count. Reading that as zero lines is the bug this guards.
    expect(lineChangeAt(MODIFIED, 15)).toEqual({
      removed: [],
      added: ['import { EDITOR_FONT_FAMILY } from "@/lib/editor-font";'],
    });
  });

  it("finds a replacement, and reports both sides", () => {
    expect(lineChangeAt(MODIFIED, 857)).toEqual({
      removed: ['              fontFamily: "Menlo, Monaco, Consolas, monospace",'],
      added: ["              fontFamily: EDITOR_FONT_FAMILY,"],
    });
  });

  it("is null for a line no hunk covers", () => {
    // A line the commit is blamed for but did not itself change.
    expect(lineChangeAt(MODIFIED, 400)).toBeNull();
  });

  it("is null for an empty diff", () => {
    expect(lineChangeAt("", 1)).toBeNull();
  });

  it("picks the line's own text out of a multi-line hunk", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "@@ -1,0 +1,3 @@",
      "+first",
      "+second",
      "+third",
    ].join("\n");

    expect(lineChangeAt(diff, 2)!.added).toEqual(["second"]);
    expect(lineChangeAt(diff, 3)!.added).toEqual(["third"]);
  });

  it("skips a hunk that added nothing", () => {
    // `+9,0` is a pure deletion: it contains no line of the new file, so a
    // parser that ignored the count would match line 9 to it and show a
    // deletion where the file has ordinary code.
    const diff = ["diff --git a/x.ts b/x.ts", "@@ -9,2 +9,0 @@", "-gone one", "-gone two"].join("\n");

    expect(lineChangeAt(diff, 9)).toBeNull();
  });

  it("does not read one file's header as another file's change", () => {
    // `--- a/b.ts` and `+++ b/b.ts` are a removed and an added line to anything
    // that only looks at the first character.
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "@@ -1 +1 @@",
      "-old a",
      "+new a",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-old b",
      "+new b",
    ].join("\n");

    expect(lineChangeAt(diff, 1)).toEqual({ removed: ["old a"], added: ["new a"] });
  });

  it("caps the removed lines", () => {
    const removed = Array.from({ length: 50 }, (_, i) => `-line ${i}`);
    const diff = ["diff --git a/x b/x", "@@ -1,50 +1 @@", ...removed, "+one"].join("\n");

    expect(lineChangeAt(diff, 1)!.removed).toHaveLength(3);
    expect(lineChangeAt(diff, 1, 10)!.removed).toHaveLength(10);
  });

  it("ignores the no-newline marker", () => {
    const diff = ["diff --git a/x b/x", "@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n");

    expect(lineChangeAt(diff, 1)).toEqual({ removed: ["a"], added: ["b"] });
  });
});
