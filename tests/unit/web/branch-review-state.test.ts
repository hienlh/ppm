import { describe, it, expect } from "bun:test";
import {
  isReviewed,
  nextUnreviewed,
  pruneReviewed,
  reviewKey,
  firstReviewable,
  reviewedCount,
  setAllReviewed,
  toggleReviewed,
  type ReviewState,
} from "../../../src/web/lib/branch-review-state.ts";
import type { BranchDiffFile } from "../../../src/types/git.ts";

function file(path: string, blob: string): BranchDiffFile {
  return { path, status: "M", additions: 1, deletions: 0, binary: false, blob };
}

describe("reviewKey", () => {
  it("is per project and per ref pair", () => {
    expect(reviewKey("ppm", "main", "feature")).toBe("ppm:branch-review:ppm:main:feature");
    expect(reviewKey("ppm", "main", "feature")).not.toBe(reviewKey("ppm", "main", "other"));
    expect(reviewKey("ppm", "main", "feature")).not.toBe(reviewKey("other", "main", "feature"));
  });
});

describe("isReviewed", () => {
  it("holds while the file's blob is the one that was reviewed", () => {
    const state: ReviewState = { "a.ts": "blob1" };
    expect(isReviewed(state, file("a.ts", "blob1"))).toBe(true);
  });

  it("clears itself when that file is rewritten", () => {
    // The whole reason a blob id is stored rather than `true`: a file the
    // branch changed again has not been reviewed in its current form.
    const state: ReviewState = { "a.ts": "blob1" };
    expect(isReviewed(state, file("a.ts", "blob2"))).toBe(false);
  });

  it("leaves other files alone when one changes", () => {
    const state: ReviewState = { "a.ts": "blob1", "b.ts": "blob9" };
    expect(isReviewed(state, file("a.ts", "blob2"))).toBe(false);
    expect(isReviewed(state, file("b.ts", "blob9"))).toBe(true);
  });
});

describe("toggleReviewed", () => {
  it("ticks a file at its current blob and unticks it again", () => {
    const files = file("a.ts", "blob1");
    const ticked = toggleReviewed({}, files);
    expect(ticked).toEqual({ "a.ts": "blob1" });
    expect(toggleReviewed(ticked, files)).toEqual({});
  });

  it("re-ticking a changed file records the new blob", () => {
    const state = toggleReviewed({ "a.ts": "blob1" }, file("a.ts", "blob2"));
    expect(state).toEqual({ "a.ts": "blob2" });
  });

  it("does not mutate the state it was given", () => {
    const state: ReviewState = { "a.ts": "blob1" };
    toggleReviewed(state, file("b.ts", "blob2"));
    expect(state).toEqual({ "a.ts": "blob1" });
  });
});

describe("reviewedCount", () => {
  it("counts only files still at their reviewed blob", () => {
    const state: ReviewState = { "a.ts": "blob1", "b.ts": "old" };
    const files = [file("a.ts", "blob1"), file("b.ts", "new"), file("c.ts", "blob3")];
    expect(reviewedCount(state, files)).toBe(1);
  });
});

describe("setAllReviewed", () => {
  it("ticks every file at its current blob", () => {
    const files = [file("a.ts", "blob1"), file("b.ts", "blob2")];
    expect(setAllReviewed({}, files, true)).toEqual({ "a.ts": "blob1", "b.ts": "blob2" });
  });

  it("clearing drops everything, including stale paths", () => {
    expect(setAllReviewed({ "gone.ts": "blob0" }, [file("a.ts", "blob1")], false)).toEqual({});
  });
});

describe("pruneReviewed", () => {
  it("drops paths the diff no longer contains", () => {
    // Otherwise a long-lived branch's record only ever grows: every path ever
    // touched stays behind after the commit that touched it is rebased away.
    const state: ReviewState = { "a.ts": "blob1", "rebased-away.ts": "blob2" };
    expect(pruneReviewed(state, [file("a.ts", "blob1")])).toEqual({ "a.ts": "blob1" });
  });

  it("keeps a path whose blob has since changed, so it can show as unreviewed", () => {
    const state: ReviewState = { "a.ts": "old" };
    expect(pruneReviewed(state, [file("a.ts", "new")])).toEqual({ "a.ts": "old" });
  });
});

describe("nextUnreviewed", () => {
  const files = [file("a.ts", "b1"), file("b.ts", "b2"), file("c.ts", "b3")];

  it("starts from the top when nothing is selected", () => {
    expect(nextUnreviewed({}, files, null)?.path).toBe("a.ts");
  });

  it("skips files already reviewed", () => {
    expect(nextUnreviewed({ "a.ts": "b1", "b.ts": "b2" }, files, null)?.path).toBe("c.ts");
  });

  it("continues after the current file", () => {
    expect(nextUnreviewed({}, files, "a.ts")?.path).toBe("b.ts");
  });

  it("wraps around to reach files above the current one", () => {
    expect(nextUnreviewed({ "c.ts": "b3" }, files, "b.ts")?.path).toBe("a.ts");
  });

  it("answers null once everything is reviewed", () => {
    expect(nextUnreviewed({ "a.ts": "b1", "b.ts": "b2", "c.ts": "b3" }, files, null)).toBeNull();
  });

  it("answers null for an empty diff", () => {
    expect(nextUnreviewed({}, [], null)).toBeNull();
  });
});

describe("firstReviewable", () => {
  const binary = (path: string): BranchDiffFile => ({
    path, status: "A", additions: 0, deletions: 0, binary: true, blob: "b",
  });

  it("skips a leading binary file so the review opens on code", () => {
    // The list is sorted by path, so `logo.png` ahead of `src/*.ts` is ordinary
    // — and landing there shows a placeholder where the diff should be.
    expect(firstReviewable([binary("logo.png"), file("src/a.ts", "b1")])?.path).toBe("src/a.ts");
  });

  it("falls back to the first entry when every file is binary", () => {
    expect(firstReviewable([binary("a.png"), binary("b.png")])?.path).toBe("a.png");
  });

  it("answers null for an empty diff", () => {
    expect(firstReviewable([])).toBeNull();
  });
});
