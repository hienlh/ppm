import { describe, expect, it } from "bun:test";
import {
  DiffSectionSplitter, parseDiffGitPath, splitDiffSections,
} from "../../../../src/services/git-changes/diff-sections.ts";

describe("parseDiffGitPath", () => {
  it("reads a plain header", () => {
    expect(parseDiffGitPath("diff --git a/src/x.ts b/src/x.ts")).toBe("src/x.ts");
  });

  it("reads a path that itself contains ' b/' by symmetry", () => {
    expect(parseDiffGitPath("diff --git a/x b/y b/x b/y")).toBe("x b/y");
    expect(parseDiffGitPath("diff --git a/ b x.txt b/ b x.txt")).toBe(" b x.txt");
  });

  it("unquotes C-quoted paths into bytes", () => {
    expect(parseDiffGitPath('diff --git "a/q\\"uote.txt" "b/q\\"uote.txt"')).toBe('q"uote.txt');
    expect(parseDiffGitPath('diff --git "a/tab\\tx.txt" "b/tab\\tx.txt"')).toBe("tab\tx.txt");
    // "tiếng" as git writes it: UTF-8 bytes in octal, read back one char per byte.
    const path = parseDiffGitPath('diff --git "a/ti\\341\\272\\277ng.txt" "b/ti\\341\\272\\277ng.txt"')!;
    expect(Buffer.from(path, "latin1").toString("utf8")).toBe("tiếng.txt");
  });

  it("refuses what it cannot read rather than guessing", () => {
    expect(parseDiffGitPath("diff --git a/x b/y")).toBeNull();
    expect(parseDiffGitPath('diff --git "a/x')).toBeNull();
    expect(parseDiffGitPath("diff --cc x")).toBeNull();
  });
});

const TWO_FILES = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/b.bin b/b.bin",
  "index 3333333..4444444 100644",
  "Binary files a/b.bin and b/b.bin differ",
  "",
].join("\n");

describe("DiffSectionSplitter", () => {
  it("splits per file and counts lines", () => {
    const [a, b] = splitDiffSections(TWO_FILES);
    expect(a!.path).toBe("a.txt");
    expect(a!.added).toBe(1);
    expect(a!.removed).toBe(1);
    expect(a!.hunks).toBe(1);
    expect(a!.text).toBe(TWO_FILES.slice(0, TWO_FILES.indexOf("diff --git a/b.bin")));
    expect(b!.path).toBe("b.bin");
    expect(b!.binary).toBe(true);
    expect(b!.indexMode).toBe("100644");
  });

  it("does not take '---' and '+++' inside a hunk for headers", () => {
    const out = [
      "diff --git a/m.md b/m.md",
      "--- a/m.md",
      "+++ b/m.md",
      "@@ -1 +1 @@",
      "--- a rule that was removed",
      "+++ a rule that was added",
      "",
    ].join("\n");
    const [s] = splitDiffSections(out);
    expect(s!.added).toBe(1);
    expect(s!.removed).toBe(1);
  });

  it("gives the same result however the output is chunked", () => {
    const whole = splitDiffSections(TWO_FILES);
    const splitter = new DiffSectionSplitter({ maxSectionBytes: Infinity, maxTotalBytes: Infinity });
    for (const ch of TWO_FILES) splitter.push(ch);
    expect(splitter.end()).toEqual(whole);
  });

  it("keeps a type change as two sections of one path", () => {
    const out = [
      "diff --git a/link b/link",
      "deleted file mode 120000",
      "@@ -1 +0,0 @@",
      "-target",
      "\\ No newline at end of file",
      "diff --git a/link b/link",
      "new file mode 100644",
      "@@ -0,0 +1 @@",
      "+now a file",
      "",
    ].join("\n");
    const sections = splitDiffSections(out);
    expect(sections.map((s) => s.path)).toEqual(["link", "link"]);
    expect(sections[0]!.deletedFile).toBe(true);
    expect(sections[0]!.oldMode).toBe("120000");
    expect(sections[1]!.newFile).toBe(true);
  });

  it("records a mode-only change", () => {
    const [s] = splitDiffSections("diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n");
    expect(s!.oldMode).toBe("100644");
    expect(s!.newMode).toBe("100755");
    expect(s!.hunks).toBe(0);
  });

  it("skips combined diffs and unmerged notices", () => {
    const out = [
      "* Unmerged path c.txt",
      "diff --cc c.txt",
      "index 1,2..3",
      "@@@ -1,1 -1,1 +1,5 @@@",
      "++<<<<<<< HEAD",
      "diff --git a/a.txt b/a.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "* Unmerged path d.txt",
      "",
    ].join("\n");
    const sections = splitDiffSections(out);
    expect(sections.map((s) => s.path)).toEqual(["a.txt"]);
    expect(sections[0]!.text).not.toContain("Unmerged");
  });

  it("drops the text of a section past the cap but keeps counting it", () => {
    const added = Array.from({ length: 60 }, (_, i) => `+line ${i}`);
    const big = ["diff --git a/big.txt b/big.txt", "@@ -1,2 +1,60 @@", "-a", "-b", ...added, ""].join("\n");
    // a.txt's section is 113 bytes, so it fits under the cap the big one blows.
    const [s, t] = splitDiffSections(big + TWO_FILES, { maxSectionBytes: 130, maxTotalBytes: 10_000 });
    expect(s!.text).toBeNull();
    expect(s!.added).toBe(60);
    expect(s!.removed).toBe(2);
    expect(t!.text).not.toBeNull();
  });

  it("stops keeping text once the run's total cap is spent", () => {
    const sections = splitDiffSections(TWO_FILES + TWO_FILES, { maxSectionBytes: 1000, maxTotalBytes: 120 });
    expect(sections[0]!.text).not.toBeNull();
    expect(sections.slice(1).some((s) => s.text === null)).toBe(true);
  });
});
