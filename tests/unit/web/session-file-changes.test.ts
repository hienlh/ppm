/**
 * The pure half of the session review: what the changes bar adds up, how a path is shown, and
 * what marking files reviewed hides.
 */
import { describe, it, expect } from "bun:test";
import {
  changeKey,
  displayPath,
  sessionChangeTotals,
  splitDisplayPath,
  splitReviewed,
  withReviewed,
} from "../../../src/web/lib/session-file-changes.ts";
import type { SessionFileChange } from "../../../src/shared/session-file-changes.ts";

const change = (path: string, over: Partial<SessionFileChange> = {}): SessionFileChange => ({
  path, status: "modified", baseline: "session", additions: 1, deletions: 1, version: "10:1", ...over,
});

describe("sessionChangeTotals", () => {
  it("adds up every file it can count and skips the ones it cannot", () => {
    expect(sessionChangeTotals([
      change("/p/a", { additions: 3, deletions: 1 }),
      change("/p/b", { additions: undefined, deletions: undefined, binary: true }),
      change("/p/c", { additions: 0, deletions: 4 }),
    ])).toEqual({ added: 3, removed: 5 });
  });
});

describe("displayPath", () => {
  it("is relative inside the project and absolute outside it", () => {
    expect(displayPath("/home/u/proj/src/a.ts", "/home/u/proj")).toBe("src/a.ts");
    expect(displayPath("/home/u/proj/src/a.ts", "/home/u/proj/")).toBe("src/a.ts");
    expect(displayPath("/etc/hosts", "/home/u/proj")).toBe("/etc/hosts");
  });

  it("does not take a sibling folder sharing the project's name as a prefix for inside it", () => {
    expect(displayPath("/home/u/proj2/a.ts", "/home/u/proj")).toBe("/home/u/proj2/a.ts");
  });

  it("handles a Windows host", () => {
    expect(displayPath("C:\\work\\proj\\src\\a.ts", "C:\\work\\proj")).toBe("src\\a.ts");
    expect(splitDisplayPath("src\\a.ts")).toEqual({ base: "a.ts", dir: "src" });
  });
});

describe("changeKey", () => {
  it("moves when the file is written again, even with the same line counts", () => {
    const before = change("/p/a", { version: "10:1" });
    expect(changeKey(change("/p/a", { version: "10:2" }))).not.toBe(changeKey(before));
    expect(changeKey(change("/p/a", { version: "10:1" }))).toBe(changeKey(before));
  });

  it("moves when a git fallback turns into the session's own copy", () => {
    expect(changeKey(change("/p/a", { baseline: "head" }))).not.toBe(changeKey(change("/p/a")));
  });

  it("moves when a mark changes what the diff is against, at the same version", () => {
    const since = changeKey(change("/p/a", { sinceReview: true }));
    expect(changeKey(change("/p/a", { reviewed: true }))).not.toBe(since);
    expect(changeKey(change("/p/a"))).not.toBe(since);
  });
});

describe("marking files reviewed", () => {
  const files = [change("/p/a"), change("/p/b", { reviewed: true }), change("/p/c", { sinceReview: true }), change("/p/d")];

  it("hides what is reviewed as it is now, and keeps a file changed since its mark", () => {
    const { pending, reviewed } = splitReviewed(files);
    expect(pending.map((f) => f.path)).toEqual(["/p/a", "/p/c", "/p/d"]);
    expect(reviewed.map((f) => f.path)).toEqual(["/p/b"]);
  });

  it("marks and unmarks ahead of the server, leaving every other file as it was", () => {
    const marked = withReviewed(files, new Set(["/p/a", "/p/c"]), true);
    expect(marked.map((f) => [f.path, !!f.reviewed, !!f.sinceReview])).toEqual([
      ["/p/a", true, false], ["/p/b", true, false], ["/p/c", true, false], ["/p/d", false, false],
    ]);
    expect(marked[3]).toBe(files[3]!);
    const unmarked = withReviewed(files, new Set(["/p/b"]), false);
    expect(unmarked[1]).toEqual(change("/p/b"));
  });

});
