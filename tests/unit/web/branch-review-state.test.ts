import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom.tsx";
import {
  isReviewed,
  loadReviewed,
  saveReviewed,
  nextUnreviewed,
  pruneReviewed,
  nextRecent,
  reviewKey,
  firstReviewable,
  reviewedCount,
  setAllReviewed,
  toggleReviewed,
  type ReviewState,
} from "../../../src/web/lib/branch-review-state.ts";
import type { BranchDiffFile } from "../../../src/types/git.ts";

// Only the storage block below needs it, but it has to be installed before anything reads
// `localStorage`, and the harness hands it back when this file is done.
installDom();
afterAll(uninstallDom);

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

describe("nextRecent", () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);

  it("moves a comparison to the front without duplicating it", () => {
    expect(nextRecent(["a", "b", "c"], "c").recent).toEqual(["c", "a", "b"]);
    expect(nextRecent(["a", "b", "c"], "c").evicted).toEqual([]);
  });

  it("adds one that was not there", () => {
    expect(nextRecent(["a"], "b").recent).toEqual(["b", "a"]);
  });

  it("evicts the least recent past the cap, so the keys stop accumulating", () => {
    // `pruneReviewed` prunes *within* a key; nothing pruned across them, so
    // every ref pair ever compared kept a `localStorage` record forever.
    const { recent, evicted } = nextRecent(keys(20), "fresh", 20);
    expect(recent).toHaveLength(20);
    expect(recent[0]).toBe("fresh");
    expect(evicted).toEqual(["k19"]);
  });

  it("evicts nothing while under the cap", () => {
    expect(nextRecent(keys(5), "fresh", 20).evicted).toEqual([]);
  });

  it("a re-touched key cannot evict anything, since the list does not grow", () => {
    const { recent, evicted } = nextRecent(keys(20), "k7", 20);
    expect(evicted).toEqual([]);
    expect(recent).toHaveLength(20);
    expect(new Set(recent).size).toBe(20);
  });
});

/**
 * What actually reaches `localStorage`.
 *
 * `nextRecent` is pinned above as a pure decision, which is the half that is easy to test and
 * was never the bug: the eviction only bounds anything if `saveReviewed` calls it, deletes
 * exactly what it evicted, and writes the new order back. That wiring had no test at all — the
 * same shape as the chip `onClick` this suite grew a DOM to close.
 */
describe("the review state on this device", () => {
  const RECENT_KEY = "ppm:branch-review:recent";
  const pair = (n: number) => reviewKey("ppm", "main", `feature-${n}`);

  beforeEach(() => localStorage.clear());

  it("remembers what it stored, across a reload", () => {
    saveReviewed(pair(1), { "src/app.ts": "blob1" });
    expect(loadReviewed(pair(1))).toEqual({ "src/app.ts": "blob1" });
  });

  it("keeps the twenty most recent ref pairs and deletes the rest", () => {
    for (let i = 1; i <= 23; i++) saveReviewed(pair(i), { "src/app.ts": `blob${i}` });

    // Three comparisons ago is gone, the newest twenty are not.
    expect(loadReviewed(pair(1))).toEqual({});
    expect(loadReviewed(pair(3))).toEqual({});
    expect(loadReviewed(pair(4))).toEqual({ "src/app.ts": "blob4" });
    expect(loadReviewed(pair(23))).toEqual({ "src/app.ts": "blob23" });

    // And the keys are really gone rather than merely unreachable: this is a device-local
    // store that used to accumulate one entry per ref pair ever compared, forever.
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(keys).toHaveLength(21); // twenty pairs plus the order itself
    expect(keys).toContain(RECENT_KEY);
    expect(keys).not.toContain(pair(1));
  });

  it("moves a pair back to the front when it is reviewed again", () => {
    for (let i = 1; i <= 20; i++) saveReviewed(pair(i), { "src/app.ts": `blob${i}` });
    saveReviewed(pair(1), { "src/app.ts": "again" }); // oldest, touched
    saveReviewed(pair(21), { "src/app.ts": "blob21" }); // evicts one — not that one

    expect(loadReviewed(pair(1))).toEqual({ "src/app.ts": "again" });
    expect(loadReviewed(pair(2))).toEqual({}); // the oldest untouched pair went instead
  });

  it("forgets a pair entirely when nothing in it is reviewed any more", () => {
    saveReviewed(pair(1), { "src/app.ts": "blob1" });
    saveReviewed(pair(1), {});
    expect(localStorage.getItem(pair(1))).toBeNull();
    expect(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")).not.toContain(pair(1));
  });
});
