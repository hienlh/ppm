/**
 * Scrolling the graph fires one `requestCommits` per page, and each spawns two
 * git processes with nothing to abort the previous pair. Pages are additive, so
 * a late append is still wanted — the thing that must not land is an answer
 * from before the list was thrown away and started again.
 */
import { describe, it, expect } from "bun:test";
import {
  beginCommitRequest,
  isStaleCommitRequest,
  type CommitRequestState,
} from "./extension.ts";

const fresh = (): CommitRequestState => ({ latest: 0, lastReset: 0 });

describe("commit-window request generations", () => {
  it("keeps a page that was asked for after the last reset", () => {
    const state = fresh();
    const first = beginCommitRequest(state, 0);
    const second = beginCommitRequest(state, 300);

    // Page two arrives after page one — the ordinary case, and both count.
    expect(isStaleCommitRequest(state, first)).toBe(false);
    expect(isStaleCommitRequest(state, second)).toBe(false);
  });

  it("drops a page that was in flight when the branch changed", () => {
    const state = fresh();
    beginCommitRequest(state, 0);
    const pageTwo = beginCommitRequest(state, 300);
    // Switching branch sends skip 0, which replaces the list rather than
    // appending to it. Page two of the old branch must not be appended to page
    // one of the new one.
    const newBranch = beginCommitRequest(state, 0);

    expect(isStaleCommitRequest(state, pageTwo)).toBe(true);
    expect(isStaleCommitRequest(state, newBranch)).toBe(false);
  });

  it("drops everything older than the newest reset, not just the one before it", () => {
    const state = fresh();
    const a = beginCommitRequest(state, 0);
    const b = beginCommitRequest(state, 300);
    const c = beginCommitRequest(state, 600);
    beginCommitRequest(state, 0);

    for (const generation of [a, b, c]) expect(isStaleCommitRequest(state, generation)).toBe(true);
  });

  it("treats a refresh as a reset even when nothing else changed", () => {
    const state = fresh();
    const before = beginCommitRequest(state, 0);
    beginCommitRequest(state, 0);

    expect(isStaleCommitRequest(state, before)).toBe(true);
  });
});
