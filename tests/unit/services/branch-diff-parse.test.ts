import { describe, it, expect } from "bun:test";
import {
  assertRef,
  mergeBranchDiff,
  parseNumstatZ,
  parseRawZ,
} from "../../../src/services/git-branch-diff/branch-diff-parse.ts";

/**
 * Records are NUL-terminated, so the fixtures are written as real `\0` strings
 * rather than prettified — the separator is the thing under test.
 */
const NUL = "\0";

describe("parseNumstatZ", () => {
  it("reads plain records", () => {
    const out = parseNumstatZ(`12\t3\tsrc/a.ts${NUL}0\t7\tsrc/b.ts${NUL}`);
    expect(out.get("src/a.ts")).toEqual({ additions: 12, deletions: 3, binary: false });
    expect(out.get("src/b.ts")).toEqual({ additions: 0, deletions: 7, binary: false });
  });

  it("reads a rename as three records, keyed by the new path", () => {
    const out = parseNumstatZ(`0\t0\t${NUL}old/name.ts${NUL}new/name.ts${NUL}`);
    expect(out.has("old/name.ts")).toBe(false);
    expect(out.get("new/name.ts")).toEqual({
      additions: 0, deletions: 0, binary: false, oldPath: "old/name.ts",
    });
  });

  it("treats `-` counts as binary rather than as zero", () => {
    const out = parseNumstatZ(`-\t-\tassets/logo.png${NUL}`);
    expect(out.get("assets/logo.png")).toEqual({ additions: 0, deletions: 0, binary: true });
  });

  it("keeps a path containing a tab intact", () => {
    // The reason for `-z`: this path splits into three fields on a naive parse,
    // and the file silently becomes "weird" with the counts attached to nothing.
    const out = parseNumstatZ(`1\t1\tsrc/we\tird.ts${NUL}`);
    expect([...out.keys()]).toEqual(["src/we\tird.ts"]);
    expect(out.get("src/we\tird.ts")?.additions).toBe(1);
  });
});

describe("parseRawZ", () => {
  const sha = (c: string) => c.repeat(40);

  it("reads status and the head-side blob", () => {
    const out = parseRawZ(`:100644 100644 ${sha("a")} ${sha("b")} M${NUL}src/a.ts${NUL}`);
    expect(out.get("src/a.ts")).toEqual({ status: "M", blob: sha("b") });
  });

  it("drops the similarity score from a rename and takes both paths", () => {
    const out = parseRawZ(`:100644 100644 ${sha("a")} ${sha("a")} R100${NUL}b.txt${NUL}c.txt${NUL}`);
    expect(out.get("c.txt")).toEqual({ status: "R", blob: sha("a"), oldPath: "b.txt" });
  });

  it("reports a deletion with an all-zero blob", () => {
    const out = parseRawZ(`:100644 000000 ${sha("a")} ${sha("0")} D${NUL}gone.ts${NUL}`);
    expect(out.get("gone.ts")?.status).toBe("D");
    expect(out.get("gone.ts")?.blob).toBe(sha("0"));
  });
});

describe("mergeBranchDiff", () => {
  const sha = (c: string) => c.repeat(40);

  it("joins counts onto the raw entries", () => {
    const files = mergeBranchDiff(
      parseNumstatZ(`12\t3\tsrc/a.ts${NUL}`),
      parseRawZ(`:100644 100644 ${sha("a")} ${sha("b")} M${NUL}src/a.ts${NUL}`),
    );
    expect(files).toEqual([{
      path: "src/a.ts", status: "M", additions: 12, deletions: 3, binary: false, blob: sha("b"),
    }]);
  });

  it("keeps a file raw reported but numstat did not", () => {
    // A mode-only change: numstat omits it entirely, and taking numstat as the
    // spine would drop it from the review with nothing to show it was skipped.
    const files = mergeBranchDiff(
      parseNumstatZ(""),
      parseRawZ(`:100644 100755 ${sha("a")} ${sha("a")} T${NUL}run.sh${NUL}`),
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "run.sh", status: "T", additions: 0, deletions: 0 });
  });

  it("sorts by path so the list order does not depend on git's", () => {
    const files = mergeBranchDiff(
      parseNumstatZ(""),
      parseRawZ(
        `:100644 100644 ${sha("a")} ${sha("b")} M${NUL}z.ts${NUL}` +
        `:100644 100644 ${sha("a")} ${sha("b")} M${NUL}a.ts${NUL}`,
      ),
    );
    expect(files.map((f) => f.path)).toEqual(["a.ts", "z.ts"]);
  });
});

describe("assertRef", () => {
  it("accepts ordinary refs", () => {
    for (const ref of ["main", "feature/x", "origin/main", "v1.2.3", "a1b2c3d"]) {
      expect(assertRef(ref, "base")).toBe(ref);
    }
  });

  it("rejects an option, a range, and control characters", () => {
    // A leading dash is read by git as an option even though argv never meets a
    // shell; `..` would smuggle a range past the caller's choice of mode.
    for (const bad of ["--output=/tmp/x", "main..feature", "main...feature", "a\nb", ""]) {
      expect(() => assertRef(bad, "base")).toThrow();
    }
  });
});
