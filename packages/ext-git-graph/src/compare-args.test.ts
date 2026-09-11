import { describe, it, expect } from "bun:test";
import {
  buildRangeSpec, parseAheadBehind, parseNumstatZ, parseRefList,
} from "./compare-args.ts";

describe("buildRangeSpec", () => {
  it("joins two refs with two dots for a commit range", () => {
    expect(buildRangeSpec("main", "feature", "two-dot")).toBe("main..feature");
  });

  it("joins two refs with three dots for a merge-base diff", () => {
    expect(buildRangeSpec("main", "feature", "three-dot")).toBe("main...feature");
  });

  it("refuses a ref that already contains a range", () => {
    // Otherwise one field could smuggle a whole range past validation.
    expect(() => buildRangeSpec("main..evil", "feature", "two-dot")).toThrow(/Invalid git ref/);
  });

  it("refuses a ref that starts with a dash", () => {
    expect(() => buildRangeSpec("--output=/tmp/x", "main", "two-dot")).toThrow(/Invalid git ref/);
  });

  it("refuses an empty ref", () => {
    expect(() => buildRangeSpec("", "main", "two-dot")).toThrow(/Invalid git ref/);
  });

  it("names which side was invalid", () => {
    expect(() => buildRangeSpec("main", "bad..ref", "two-dot")).toThrow(/ref2/);
  });
});

describe("parseNumstatZ", () => {
  it("reads additions and deletions per file", () => {
    const stdout = "3\t1\tsrc/app.ts\0" + "0\t7\tsrc/old.ts\0";

    expect(parseNumstatZ(stdout)).toEqual([
      { path: "src/app.ts", additions: 3, deletions: 1, binary: false },
      { path: "src/old.ts", additions: 0, deletions: 7, binary: false },
    ]);
  });

  it("marks a binary file instead of reporting it as zero changes", () => {
    const stdout = "-\t-\tassets/logo.png\0";

    expect(parseNumstatZ(stdout)).toEqual([
      { path: "assets/logo.png", additions: 0, deletions: 0, binary: true },
    ]);
  });

  it("reads a rename, whose paths arrive as two extra records", () => {
    const stdout = "2\t2\t\0src/old.ts\0src/new.ts\0";

    expect(parseNumstatZ(stdout)).toEqual([
      { path: "src/new.ts", oldPath: "src/old.ts", additions: 2, deletions: 2, binary: false },
    ]);
  });

  it("keeps reading files after a rename", () => {
    const stdout = "2\t2\t\0src/old.ts\0src/new.ts\0" + "1\t0\tREADME.md\0";

    const changes = parseNumstatZ(stdout);

    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual({ path: "README.md", additions: 1, deletions: 0, binary: false });
  });

  it("handles a path containing a space", () => {
    const stdout = "1\t1\tsrc/my file.ts\0";

    expect(parseNumstatZ(stdout)[0]!.path).toBe("src/my file.ts");
  });

  it("returns nothing for identical trees", () => {
    expect(parseNumstatZ("")).toEqual([]);
  });
});

describe("parseAheadBehind", () => {
  it("reads the left/right counts", () => {
    expect(parseAheadBehind("3\t7\n")).toEqual({ behind: 3, ahead: 7 });
  });

  it("reads zeros for identical refs", () => {
    expect(parseAheadBehind("0\t0\n")).toEqual({ behind: 0, ahead: 0 });
  });

  it("falls back to zeros on unexpected output", () => {
    expect(parseAheadBehind("")).toEqual({ behind: 0, ahead: 0 });
  });
});

describe("parseRefList", () => {
  it("classifies branches, remotes and tags", () => {
    const stdout = [
      `refs/heads/main\x1faaa\x1fmain`,
      `refs/remotes/origin/main\x1fbbb\x1forigin/main`,
      `refs/tags/v1.0.0\x1fccc\x1fv1.0.0`,
    ].join("\n");

    expect(parseRefList(stdout)).toEqual([
      { name: "main", hash: "aaa", kind: "head" },
      { name: "origin/main", hash: "bbb", kind: "remote" },
      { name: "v1.0.0", hash: "ccc", kind: "tag" },
    ]);
  });

  it("skips malformed lines", () => {
    expect(parseRefList("refs/heads/main\n\n")).toEqual([]);
  });
});
