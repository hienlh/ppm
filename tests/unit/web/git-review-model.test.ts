import { describe, expect, it } from "bun:test";
import {
  blockId,
  fileBlocks,
  fileReviews,
  fileSignature,
  firstInFile,
  hunkIndex,
  nextFileFocus,
  nextOpen,
  numberedRows,
  paneItems,
  pickableLines,
  pickRequest,
  railGroup,
  railOrder,
  rangeText,
  resolveFocus,
  reviewTotals,
  stepFocus,
  type DiscardedEntry,
  type FileReview,
  type ReviewBlock,
} from "../../../src/web/lib/git-review-model";
import type { ChangeBlock, ChangedFile, ChangeHunk, ChangeLine, FileChangeDetail } from "../../../src/shared/git-changes";

function blk(id: string, index: number, oldStart: number, oldLines: number, newStart: number, newLines: number): ChangeBlock {
  return { id, index, oldStart, oldLines, newStart, newLines, added: Math.max(0, newLines - oldLines), removed: Math.max(0, oldLines - newLines) };
}

function hunk(b: ChangeBlock, lines: ChangeLine[]): ChangeHunk {
  return { ...b, heading: "", lines };
}

function file(path: string, staged: ChangeBlock[] | null, unstaged: ChangeBlock[] | null, extra: Partial<ChangedFile> = {}): ChangedFile {
  const side = (blocks: ChangeBlock[] | null) =>
    blocks && { blocks, added: blocks.reduce((n, b) => n + b.added, 0), removed: blocks.reduce((n, b) => n + b.removed, 0) };
  return {
    path,
    x: staged ? "M" : ".",
    y: unstaged ? "M" : ".",
    untracked: false,
    conflict: false,
    staged: side(staged),
    unstaged: side(unstaged),
    ...extra,
  };
}

const NONE = new Map();
const keys = (blocks: ReviewBlock[]) => blocks.map((b) => `${b.key}:${b.state}`);

// src/a.ts: one staged block at index lines 10–17, open ones at 1–4 and 40–44.
const S1 = blk("s1", 0, 10, 6, 10, 8);
const U1 = blk("u1", 1, 40, 5, 40, 6);
const U2 = blk("u2", 0, 1, 4, 1, 5);
const A = file("src/a.ts", [S1], [U2, U1]);

describe("fileBlocks", () => {
  it("puts staged and open blocks in one list by where they sit in the index", () => {
    const blocks = fileBlocks({ path: A.path, file: A, detail: null, discards: [], pending: NONE });
    expect(keys(blocks)).toEqual(["u:u2:open", "s:s1:staged", "u:u1:open"]);
    // Without the detail there are no lines yet, only positions.
    expect(blocks.every((b) => b.parts === null)).toBe(true);
  });

  it("takes the lines from the detail once it has loaded", () => {
    const lines: ChangeLine[] = [{ kind: " ", text: "a" }, { kind: "+", text: "b" }];
    const detail: FileChangeDetail = {
      path: A.path, x: "M", y: "M", untracked: false, conflict: false,
      staged: { hunks: [hunk(S1, lines)], added: 2, removed: 0 },
      unstaged: { hunks: [hunk(U2, lines), hunk(U1, lines)], added: 2, removed: 0 },
    };
    const blocks = fileBlocks({ path: A.path, file: A, detail, discards: [], pending: NONE });
    expect(blocks.map((b) => b.parts?.[0]?.lines.length)).toEqual([2, 2, 2]);
  });

  it("tells two copies of the same edit apart", () => {
    const f = file("b.ts", null, [blk("same", 0, 5, 3, 5, 4), blk("same", 1, 50, 3, 51, 4)]);
    expect(fileBlocks({ path: f.path, file: f, detail: null, discards: [], pending: NONE }).map((b) => b.key)).toEqual(["u:same", "u:same#2"]);
  });

  it("makes a side git does not split into one whole-file block", () => {
    const bin = file("logo.png", null, [], { unstaged: { blocks: [], whole: "binary", added: 0, removed: 0 } });
    const [b] = fileBlocks({ path: bin.path, file: bin, detail: null, discards: [], pending: NONE });
    expect(b).toMatchObject({ key: "u:whole", whole: "binary", hunk: null, state: "open" });
  });

  it("shows a deleted file as one block rather than every line it had", () => {
    const del = file("old.ts", null, [blk("d", 0, 1, 30, 0, 0)], { y: "D" });
    const [b] = fileBlocks({ path: del.path, file: del, detail: null, discards: [], pending: NONE });
    expect(b).toMatchObject({ key: "u:whole", whole: "deleted", removed: 30 });
  });

  it("lists a staged rename's edits, though they are one change to git", () => {
    const ren = file("new.ts", null, null, { x: "R", oldPath: "old.ts", staged: { blocks: [], whole: "rename", added: 1, removed: 0 } });
    const detail: FileChangeDetail = {
      path: "new.ts", oldPath: "old.ts", x: "R", y: ".", untracked: false, conflict: false,
      staged: { hunks: [hunk(blk("r", 0, 3, 2, 3, 3), [{ kind: "+", text: "x" }])], whole: "rename", added: 1, removed: 0 },
      unstaged: null,
    };
    const [b] = fileBlocks({ path: ren.path, file: ren, detail, discards: [], pending: NONE });
    expect(b).toMatchObject({ key: "s:whole", whole: "rename", state: "staged" });
    expect(b!.parts).toHaveLength(1);
  });

  it("shows what an action in flight will make of a block", () => {
    const pending = new Map([[blockId(A.path, "u:u1"), "staged" as const]]);
    expect(keys(fileBlocks({ path: A.path, file: A, detail: null, discards: [], pending }))).toEqual(["u:u2:open", "s:s1:staged", "u:u1:staged"]);
  });

  it("never shows a block twice while its discard is on its way", () => {
    const entry: DiscardedEntry = { path: A.path, recordId: "r1", hunks: [hunk(U1, [{ kind: "+", text: "x" }])], whole: null, added: 1, removed: 0 };
    const pending = new Map([[blockId(A.path, "u:u1"), "discarded" as const]]);
    expect(keys(fileBlocks({ path: A.path, file: A, detail: null, discards: [entry], pending }))).toEqual([
      "u:u2:open", "s:s1:staged", "d:r1:0:discarded",
    ]);
  });

  it("keeps a discard where it was in the file", () => {
    const f = file("c.ts", null, [blk("late", 0, 90, 3, 90, 4)]);
    const entry: DiscardedEntry = { path: f.path, recordId: "r2", hunks: [hunk(blk("gone", 0, 20, 3, 20, 5), [])], whole: null, added: 2, removed: 0 };
    const blocks = fileBlocks({ path: f.path, file: f, detail: null, discards: [entry], pending: NONE });
    expect(keys(blocks)).toEqual(["d:r2:0:discarded", "u:late:open"]);
    expect(blocks[0]!.recordId).toBe("r2");
  });
});

describe("paneItems", () => {
  it("counts the unchanged lines between blocks in the index's numbering", () => {
    const blocks = fileBlocks({ path: A.path, file: A, detail: null, discards: [], pending: NONE });
    expect(paneItems(blocks).map((i) => (i.kind === "gap" ? `gap ${i.lines}` : i.block.key))).toEqual([
      "u:u2", "gap 5", "s:s1", "gap 22", "u:u1",
    ]);
  });

  it("counts nothing twice where a staged and an open block share context", () => {
    const f = file("d.ts", [blk("s", 0, 10, 6, 10, 8)], [blk("u", 0, 15, 6, 15, 7)]);
    const items = paneItems(fileBlocks({ path: f.path, file: f, detail: null, discards: [], pending: NONE }));
    expect(items.map((i) => i.kind)).toEqual(["gap", "block", "block"]);
    expect(items[0]).toMatchObject({ kind: "gap", lines: 9 });
  });

  it("puts nothing around a whole-file block", () => {
    const bin = file("logo.png", null, [], { unstaged: { blocks: [], whole: "binary", added: 0, removed: 0 } });
    expect(paneItems(fileBlocks({ path: bin.path, file: bin, detail: null, discards: [], pending: NONE })).map((i) => i.kind)).toEqual(["block"]);
  });
});

describe("the rail and the progress", () => {
  const B = file("src/b.ts", [blk("bs", 0, 3, 3, 3, 4)], null);
  const gone: DiscardedEntry = { path: "src/gone.ts", recordId: "r3", hunks: [], whole: "binary", added: 0, removed: 0 };
  const reviews = fileReviews({ files: [A, B, file("x.ts", null, null, { conflict: true, x: "U", y: "U" })], details: new Map(), discards: [gone], pending: NONE });

  it("groups files by what is left to decide in them", () => {
    expect(reviews.map((r) => `${r.path}:${railGroup(r)}`)).toEqual(["src/a.ts:changes", "src/b.ts:staged", "src/gone.ts:discarded"]);
  });

  it("leaves conflicts out: they have no blocks until they are resolved", () => {
    expect(reviews.some((r) => r.path === "x.ts")).toBe(false);
  });

  it("orders the rail Changes, Staged, Discarded", () => {
    const mixed = [reviews[2]!, reviews[1]!, reviews[0]!];
    expect(railOrder(mixed).map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts", "src/gone.ts"]);
  });

  it("counts blocks still in the files, and discards apart", () => {
    expect(reviewTotals(reviews)).toMatchObject({ files: 2, blocks: 4, staged: 2, discarded: 1 });
  });
});

describe("moving the focus", () => {
  const B = file("src/b.ts", null, [blk("b1", 0, 3, 3, 3, 4), blk("b2", 1, 30, 3, 30, 4)]);
  const C = file("src/c.ts", [blk("c1", 0, 3, 3, 3, 4)], null);
  const reviews = fileReviews({ files: [C, A, B], details: new Map(), discards: [], pending: NONE });

  it("steps through every block in rail order and stops at the ends", () => {
    // c.ts is all staged, so the rail puts it after the two files with open blocks.
    expect(stepFocus(reviews, { path: "src/a.ts", key: "u:u1" }, 1)).toEqual({ path: "src/b.ts", key: "u:b1" });
    expect(stepFocus(reviews, { path: "src/c.ts", key: "s:c1" }, 1)).toEqual({ path: "src/c.ts", key: "s:c1" });
    expect(stepFocus(reviews, { path: "src/a.ts", key: "u:u2" }, -1)).toEqual({ path: "src/a.ts", key: "u:u2" });
  });

  it("moves an answer on to the next open block, wrapping round", () => {
    expect(nextOpen(reviews, { path: "src/a.ts", key: "u:u2" })).toEqual({ path: "src/a.ts", key: "u:u1" });
    expect(nextOpen(reviews, { path: "src/b.ts", key: "u:b2" })).toEqual({ path: "src/a.ts", key: "u:u2" });
  });

  it("moves on to the next file in the list once a file's last open block is answered", () => {
    // Deciding q.ts's last block regroups it under Staged; walking the rail from
    // there would wrap round to the first file instead of the one after it.
    const P = file("src/p.ts", null, [blk("p1", 0, 3, 3, 3, 4)]);
    const Q = file("src/q.ts", null, [blk("q1", 0, 3, 3, 3, 4)]);
    const R = file("src/r.ts", null, [blk("r1", 0, 3, 3, 3, 4)]);
    const pending = new Map([[blockId(Q.path, "u:q1"), "staged" as const]]);
    const after = fileReviews({ files: [P, Q, R], details: new Map(), discards: [], pending });
    expect(nextOpen(after, { path: "src/q.ts", key: "u:q1" })).toEqual({ path: "src/r.ts", key: "u:r1" });
  });

  it("finds nothing open once every block is decided", () => {
    const done = fileReviews({ files: [C], details: new Map(), discards: [], pending: NONE });
    expect(nextOpen(done, { path: "src/c.ts", key: "s:c1" })).toBeNull();
  });

  it("opens a file on its first open block", () => {
    expect(firstInFile(reviews.find((r) => r.path === "src/a.ts")!)).toEqual({ path: "src/a.ts", key: "u:u2" });
  });

  it("goes to the next file with something open", () => {
    expect(nextFileFocus(reviews, "src/a.ts")).toEqual({ path: "src/b.ts", key: "u:b1" });
    expect(nextFileFocus(reviews, "src/b.ts")).toEqual({ path: "src/a.ts", key: "u:u2" });
  });

  it("lands on the nearest open block when the focused one changed its key", () => {
    // s:s1 was unstaged: git now lists an open block near line 10 under a new fingerprint.
    const after = fileReviews({ files: [file("src/a.ts", null, [U2, blk("new", 1, 10, 8, 10, 9), U1])], details: new Map(), discards: [], pending: NONE });
    expect(resolveFocus(after, { path: "src/a.ts", key: "s:s1", anchor: 10 })).toEqual({ path: "src/a.ts", key: "u:new" });
  });

  it("hands over to the first open block once the file is gone", () => {
    expect(resolveFocus(reviews, { path: "src/zz.ts", key: "u:x" })).toEqual({ path: "src/a.ts", key: "u:u2" });
    expect(resolveFocus([], { path: "src/zz.ts", key: "u:x" })).toBeNull();
  });
});

describe("lines", () => {
  const lines: ChangeLine[] = [
    { kind: " ", text: "keep" },
    { kind: "-", text: "old" },
    { kind: "+", text: "new" },
    { kind: "+", text: "more" },
    { kind: " ", text: "tail" },
  ];
  const f = file("e.ts", null, [blk("e", 0, 12, 3, 12, 4)]);
  const detail: FileChangeDetail = {
    path: "e.ts", x: ".", y: "M", untracked: false, conflict: false, staged: null,
    unstaged: { hunks: [hunk(blk("e", 0, 12, 3, 12, 4), lines)], added: 2, removed: 1 },
  };
  const [block] = fileBlocks({ path: "e.ts", file: f, detail, discards: [], pending: NONE });

  it("numbers each line on both sides", () => {
    expect(numberedRows(block!.parts![0]!).map((r) => [r.old, r.new])).toEqual([[12, 12], [13, null], [null, 13], [null, 14], [14, 15]]);
  });

  it("names the range a block covers", () => {
    expect(rangeText(block!)).toBe("Lines 12–15");
    expect(rangeText({ ...block!, state: "discarded" })).toBe("Lines 12–14");
    const removal = { ...block!, parts: [{ oldStart: 7, newStart: 6, lines: [{ kind: "-", text: "a" }, { kind: "-", text: "b" }] as ChangeLine[] }] };
    expect(rangeText(removal)).toBe("Lines 7–8, removed");
  });

  it("ticks changed lines only, and sends a full pick as the whole block", () => {
    expect(pickableLines(block!)).toEqual([1, 2, 3]);
    expect(pickRequest(block!, new Set([2]))).toEqual([2]);
    expect(pickRequest(block!, new Set([0, 1, 2, 3]))).toBeNull();
  });

  it("names a hunk by where its copy sits in a fresh list", () => {
    const fresh = [blk("x", 0, 1, 1, 1, 1), blk("dup", 1, 5, 1, 5, 1), blk("dup", 2, 9, 1, 9, 1)];
    expect(hunkIndex(fresh, "u:dup")).toBe(1);
    expect(hunkIndex(fresh, "u:dup#2")).toBe(2);
    expect(hunkIndex(fresh, "u:dup#3")).toBeNull();
    expect(hunkIndex(fresh, "u:whole")).toBeNull();
  });
});

describe("fileSignature", () => {
  it("changes when a side gains or loses a block, and only then", () => {
    const before = fileSignature(A);
    expect(fileSignature(file("src/a.ts", [S1], [U2, U1]))).toBe(before);
    expect(fileSignature(file("src/a.ts", [S1, U1], [U2]))).not.toBe(before);
  });
});

// Keeps the fixture honest: every file above is reviewable.
it("reviews every fixture file", () => {
  const all: FileReview[] = fileReviews({ files: [A], details: new Map(), discards: [], pending: NONE });
  expect(all).toHaveLength(1);
});
