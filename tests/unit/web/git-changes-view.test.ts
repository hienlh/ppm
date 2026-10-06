import { describe, expect, it } from "bun:test";
import type { ChangedFile, ChangeSide, GitBranchState, GitChanges } from "../../../src/shared/git-changes";
import {
  allCheckState,
  blockDots,
  canCommit,
  discardSummary,
  changeCounts,
  changeLetter,
  changesToStatus,
  changeTotals,
  commitHint,
  fileCheckState,
  hasConflictMarkers,
  lineNote,
  operationTitle,
  unstagePaths,
  syncIsPrimary,
  syncMode,
} from "../../../src/web/lib/git-changes-view";

const block = (oldStart: number, oldLines: number, newStart: number, newLines: number, added = 1, removed = 1) =>
  ({ id: `${oldStart}:${newStart}`, index: 0, oldStart, oldLines, newStart, newLines, added, removed });
const side = (blocks: ReturnType<typeof block>[], extra: Partial<ChangeSide> = {}): ChangeSide => ({
  blocks,
  added: blocks.reduce((n, b) => n + b.added, 0),
  removed: blocks.reduce((n, b) => n + b.removed, 0),
  ...extra,
});
const file = (over: Partial<ChangedFile>): ChangedFile => ({
  path: "src/a.ts", x: ".", y: ".", untracked: false, conflict: false, staged: null, unstaged: null, ...over,
});
const branch = (over: Partial<GitBranchState> = {}): GitBranchState => ({
  head: "main", oid: "abc", upstream: "origin/main", upstreamGone: false, ahead: 0, behind: 0, hasRemote: true, ...over,
});

describe("checkboxes", () => {
  const staged = file({ x: "M", staged: side([block(1, 1, 1, 1)]) });
  const partly = file({ x: "M", y: "M", staged: side([block(1, 1, 1, 1)]), unstaged: side([block(9, 1, 9, 1)]) });
  const open = file({ y: "M", unstaged: side([block(1, 1, 1, 1)]) });
  const untracked = file({ x: "?", y: "?", untracked: true, unstaged: side([block(0, 0, 1, 3, 3, 0)]) });
  const conflict = file({ x: "U", y: "U", conflict: true });

  it("ticks a file only when nothing in it is left unstaged", () => {
    expect(fileCheckState(staged)).toBe("all");
    expect(fileCheckState(partly)).toBe("some");
    expect(fileCheckState(open)).toBe("none");
    expect(fileCheckState(untracked)).toBe("none");
  });

  it("leaves conflicts out of the header's tick", () => {
    expect(allCheckState([staged, conflict])).toBe("all");
    expect(allCheckState([staged, open])).toBe("some");
    expect(allCheckState([open, untracked])).toBe("none");
    expect(allCheckState([conflict])).toBe("none");
  });

  it("names the source of a rename when unstaging the whole file", () => {
    expect(unstagePaths(file({ path: "new.ts", oldPath: "old.ts", x: "R" }))).toEqual(["new.ts", "old.ts"]);
    expect(unstagePaths(open)).toEqual(["src/a.ts"]);
  });
});

describe("status letter and counts", () => {
  it("reads a new file as added whether or not it is staged, and a conflict as U", () => {
    expect(changeLetter(file({ x: "?", y: "?", untracked: true }))).toBe("A");
    expect(changeLetter(file({ x: "A" }))).toBe("A");
    expect(changeLetter(file({ x: "R", oldPath: "b.ts" }))).toBe("R");
    expect(changeLetter(file({ y: "D" }))).toBe("D");
    expect(changeLetter(file({ x: "M", y: "M" }))).toBe("M");
    expect(changeLetter(file({ x: "U", y: "U", conflict: true }))).toBe("U");
    expect(changeLetter(file({ x: "T" }))).toBe("M");
  });

  it("adds up both sides", () => {
    const f = file({ staged: side([block(1, 1, 1, 2, 2, 1)]), unstaged: side([block(9, 3, 10, 0, 0, 3)]) });
    expect(changeCounts(f)).toEqual({ added: 2, removed: 4 });
  });

  it("names a change with no lines instead of counting it as +0, except a rename", () => {
    expect(lineNote(file({ y: "M", unstaged: side([], { whole: "binary" }) }))).toBe("binary");
    expect(lineNote(file({ x: "M", staged: side([], { whole: "mode" }) }))).toBe("mode");
    expect(lineNote(file({ x: "R", oldPath: "b.ts", staged: side([], { whole: "rename" }) }))).toBeNull();
    expect(lineNote(file({ y: "M", unstaged: side([block(1, 1, 1, 1)]) }))).toBeNull();
  });
});

describe("hasConflictMarkers", () => {
  it("finds git's start and end markers, and only at the start of a line", () => {
    expect(hasConflictMarkers("a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n")).toBe(true);
    expect(hasConflictMarkers("a\n>>>>>>>\n")).toBe(true);
    expect(hasConflictMarkers("const s = '<<<<<<< HEAD';\n=======\n")).toBe(false);
    expect(hasConflictMarkers("<<<<<<<<< not a marker\n")).toBe(false);
  });
});

describe("block dots", () => {
  it("puts staged and unstaged blocks in file order", () => {
    // Staged at index line 20; unstaged at index lines 5 and 40.
    const f = file({
      staged: side([block(20, 1, 20, 1)]),
      unstaged: side([block(5, 1, 5, 1), block(40, 1, 40, 1)]),
    });
    expect(blockDots(f)).toEqual([false, true, false]);
  });

  it("counts a side that is not split into blocks as one", () => {
    const f = file({ staged: side([], { whole: "binary" }), unstaged: side([], { whole: "binary" }) });
    expect(blockDots(f)).toEqual([true, false]);
  });
});

describe("sync button", () => {
  it("offers what the branch needs", () => {
    expect(syncMode(branch())).toBe("synced");
    expect(syncMode(branch({ ahead: 2 }))).toBe("push");
    expect(syncMode(branch({ behind: 1 }))).toBe("pull");
    expect(syncMode(branch({ ahead: 1, behind: 1 }))).toBe("sync");
    expect(syncMode(branch({ upstream: null }))).toBe("publish");
  });

  it("publishes again when the upstream was deleted, instead of calling it synced", () => {
    expect(syncMode(branch({ upstreamGone: true }))).toBe("publish");
  });

  it("has nothing to offer on a detached HEAD or without a remote", () => {
    expect(syncMode(branch({ head: null }))).toBeNull();
    expect(syncMode(branch({ hasRemote: false, upstream: null }))).toBeNull();
  });

  it("becomes the primary action only once there is nothing to commit", () => {
    expect(syncIsPrimary("push", 0)).toBe(true);
    expect(syncIsPrimary("push", 3)).toBe(false);
    expect(syncIsPrimary("synced", 0)).toBe(false);
    expect(syncIsPrimary(null, 0)).toBe(false);
  });
});

describe("commit box", () => {
  const staged = file({ x: "M", staged: side([block(1, 1, 1, 1)]), unstaged: side([block(9, 1, 9, 1)]) });
  const open = file({ path: "b.ts", y: "M", unstaged: side([block(1, 1, 1, 1)]) });

  it("says what is missing, in the order it has to be done", () => {
    expect(commitHint(changeTotals([]), "")).toBe("Nothing to commit");
    expect(commitHint(changeTotals([open]), "msg")).toBe("Tick a file or stage a block to commit");
    expect(commitHint(changeTotals([staged, open]), " ")).toBe("Write a message to commit");
    expect(commitHint(changeTotals([staged, open]), "fix")).toBe("1 of 3 blocks staged · ⌘↵ commits");
  });

  it("will not commit over a conflict, which git would refuse anyway", () => {
    const conflict = file({ path: "c.ts", x: "U", y: "U", conflict: true });
    expect(canCommit(changeTotals([staged]), "fix")).toBe(true);
    expect(canCommit(changeTotals([staged, conflict]), "fix")).toBe(false);
    expect(commitHint(changeTotals([staged, conflict]), "fix")).toBe("Resolve 1 conflict to commit");
  });
});

describe("operationTitle", () => {
  it("names what is being merged and where", () => {
    expect(operationTitle({ kind: "merge", name: "main", head: "abc1234" }, "feature")).toBe("Merging main into feature");
    expect(operationTitle({ kind: "rebase", name: "feature", step: 2, total: 5 }, null)).toBe("Rebasing feature (2 of 5)");
    expect(operationTitle({ kind: "cherry-pick", head: "abc1234" }, "main")).toBe("Cherry-picking abc1234 into main");
  });
});

describe("changesToStatus", () => {
  it("gives the rest of the app the /git/status shape it reads", () => {
    const changes: GitChanges = {
      branch: branch({ ahead: 1 }),
      operation: null,
      stashes: 0,
      lastCommit: null,
      truncated: false,
      files: [
        file({ path: "both.ts", x: "M", y: "M", staged: side([block(1, 1, 1, 1)]), unstaged: side([block(5, 1, 5, 1)]) }),
        file({ path: "new.ts", oldPath: "old.ts", x: "R", staged: side([], { whole: "rename" }) }),
        file({ path: "gone.ts", y: "D", unstaged: side([block(1, 3, 0, 0, 0, 3)]) }),
        file({ path: "fresh.ts", x: "?", y: "?", untracked: true, unstaged: side([]) }),
        file({ path: "clash.ts", x: "U", y: "U", conflict: true }),
      ],
    };
    expect(changesToStatus(changes)).toEqual({
      current: "main",
      ahead: 1,
      behind: 0,
      tracking: "origin/main",
      staged: [{ path: "both.ts", status: "M" }, { path: "new.ts", status: "R", oldPath: "old.ts" }],
      unstaged: [{ path: "both.ts", status: "M" }, { path: "gone.ts", status: "D" }, { path: "clash.ts", status: "M" }],
      untracked: ["fresh.ts"],
    });
  });
});

describe("discardSummary", () => {
  it("counts what goes and what stays", () => {
    const f = file({ path: "src/a.ts", staged: side([block(1, 1, 1, 1)]), unstaged: side([block(5, 1, 5, 1), block(9, 1, 9, 1)]) });
    expect(discardSummary([f])).toEqual({
      title: "Discard changes to a.ts?",
      body: "This puts 2 unstaged blocks back to the staged version. The 1 staged block stays. You can undo it right after.",
      confirm: "Discard 2 blocks",
    });
  });

  it("says a new file is deleted", () => {
    const f = file({ path: "n.ts", untracked: true, unstaged: side([block(0, 0, 1, 2, 2, 0)]) });
    expect(discardSummary([f]).confirm).toBe("Delete file");
  });

  it("sums up several files", () => {
    const a = file({ path: "a.ts", unstaged: side([block(1, 1, 1, 1)]) });
    const n = file({ path: "n.ts", untracked: true, unstaged: side([]) });
    expect(discardSummary([a, n])).toEqual({
      title: "Discard changes to 2 files?",
      body: "This puts the unstaged changes back the way the index has them, and deletes 1 new file. Staged changes stay. You can undo it right after.",
      confirm: "Discard 2 files",
    });
  });
});
