/**
 * The Review tab's pure half: block states across files, where a block reverted in this sitting
 * still sits, and where focus goes after an answer.
 */
import { describe, expect, it } from "bun:test";
import { computeBlocks, revertBlocks } from "../../../src/shared/review-blocks";
import {
  WHOLE_FILE,
  answerKey,
  changedSpans,
  fileOutcome,
  fileReviews,
  nextOpen,
  paneModel,
  reviewProgress,
  shownRows,
  stepBlock,
  type RevertedBlock,
} from "../../../src/web/lib/session-review-model";
import type { SessionFileChange } from "../../../src/shared/session-file-changes";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
const replaceLine = (text: string, at: number, by: string) => text.split("\n").map((l, i) => (i === at - 1 ? by : l)).join("\n");

function file(path: string, blocks: { key: string; kept?: boolean }[] | undefined, extra: Partial<SessionFileChange> = {}): SessionFileChange {
  return { path, status: "modified", baseline: "session", version: "v1", base: "b1", ...(blocks ? { blocks: blocks.map((b) => ({ added: 1, removed: 1, ...b })) } : {}), ...extra };
}

function ghost(key: string, extra: Partial<RevertedBlock> = {}): RevertedBlock {
  return { key, rows: [], oldFrom: Number.parseInt(key, 10), oldTo: Number.parseInt(key, 10) + 4, added: 1, removed: 1, base: "b1", drawnVersion: "v0", ...extra };
}

const states = (r: { blocks: { state: string }[] }) => r.blocks.map((b) => b.state);

describe("fileReviews", () => {
  it("lists every block of every file in file order, a reverted one where it sat", () => {
    const [a] = fileReviews({
      order: ["/a.ts"],
      files: [file("/a.ts", [{ key: "2.x", kept: true }, { key: "40.y" }])],
      reverted: new Map([["/a.ts", [ghost("20.z")]]]),
      gone: new Map(),
    });
    expect(a!.blocks).toEqual([{ key: "2.x", state: "kept" }, { key: "20.z", state: "reverted" }, { key: "40.y", state: "open" }]);
    expect(a!.open).toBe(1);
  });

  it("shows a still-listed block as reverted only while the list predates the revert", () => {
    const reverted = new Map([["/a.ts", [ghost("2.x", { drawnVersion: "v1" })]]]);
    const before = fileReviews({ order: ["/a.ts"], files: [file("/a.ts", [{ key: "2.x" }])], reverted, gone: new Map() });
    expect(states(before[0]!)).toEqual(["reverted"]);
    // A newer version still has the block: the agent wrote those lines again.
    const after = fileReviews({ order: ["/a.ts"], files: [file("/a.ts", [{ key: "2.x" }], { version: "v2" })], reverted, gone: new Map() });
    expect(states(after[0]!)).toEqual(["open"]);
  });

  it("leaves out a reverted block cut against another base", () => {
    const [a] = fileReviews({
      order: ["/a.ts"],
      files: [file("/a.ts", [{ key: "2.x" }], { base: "b2" })],
      reverted: new Map([["/a.ts", [ghost("20.z")]]]),
      gone: new Map(),
    });
    expect(a!.blocks.map((b) => b.key)).toEqual(["2.x"]);
  });

  it("answers a file without blocks whole, and keeps a fully reverted file in its place", () => {
    const reviews = fileReviews({
      order: ["/gone.ts", "/logo.png", "/a.ts"],
      files: [file("/a.ts", [{ key: "2.x" }]), file("/logo.png", undefined, { binary: true, reviewed: true })],
      reverted: new Map([["/gone.ts", [ghost("0.q")]]]),
      gone: new Map([["/gone.ts", { file: file("/gone.ts", [{ key: "0.q" }]), text: "" }]]),
    });
    expect(reviews.map((r) => [r.path, r.gone, states(r)])).toEqual([
      ["/gone.ts", true, ["reverted"]],
      ["/logo.png", false, ["kept"]],
      ["/a.ts", false, ["open"]],
    ]);
    expect(reviews[1]!.blocks[0]!.key).toBe(WHOLE_FILE);
  });

  it("shows an answer on its way at once", () => {
    const [a] = fileReviews({
      order: ["/a.ts"],
      files: [file("/a.ts", [{ key: "2.x" }, { key: "40.y" }])],
      reverted: new Map(),
      gone: new Map(),
      pending: new Map([[answerKey("/a.ts", "40.y"), "kept"]]),
    });
    expect(states(a!)).toEqual(["open", "kept"]);
  });
});

describe("progress, outcome and order", () => {
  const reviews = fileReviews({
    order: ["/a.ts", "/b.ts", "/c.ts"],
    files: [
      file("/a.ts", [{ key: "2.x", kept: true }, { key: "40.y" }]),
      file("/b.ts", [{ key: "2.x", kept: true }]),
      file("/c.ts", [{ key: "1.x" }, { key: "30.y" }]),
    ],
    reverted: new Map([["/b.ts", [ghost("20.z")]]]),
    gone: new Map(),
  });

  it("counts blocks decided and left across files", () => {
    expect(reviewProgress(reviews)).toEqual({ total: 6, kept: 2, reverted: 1, open: 3 });
    expect(fileOutcome(reviews[1]!)).toEqual({ tone: "mixed", label: "1 kept · 1 reverted" });
  });

  it("moves on to the next open block: the rest of the file, the files after, then back round", () => {
    expect(nextOpen(reviews, { path: "/a.ts", key: "2.x" })).toEqual({ path: "/a.ts", key: "40.y" });
    expect(nextOpen(reviews, { path: "/a.ts", key: "40.y" })).toEqual({ path: "/c.ts", key: "1.x" });
    expect(nextOpen(reviews, { path: "/c.ts", key: "30.y" })).toEqual({ path: "/a.ts", key: "40.y" });
    expect(nextOpen(reviews, null)).toEqual({ path: "/a.ts", key: "40.y" });
    const done = reviews.map((r) => ({ ...r, blocks: r.blocks.map((b) => ({ ...b, state: "kept" as const })), open: 0 }));
    expect(nextOpen(done, { path: "/a.ts", key: "2.x" })).toBeNull();
  });

  it("steps through every block, files left to review first, wrapping", () => {
    // b.ts is done, so it comes last.
    expect(stepBlock(reviews, { path: "/c.ts", key: "30.y" }, 1)).toEqual({ path: "/b.ts", key: "2.x" });
    expect(stepBlock(reviews, { path: "/a.ts", key: "2.x" }, -1)).toEqual({ path: "/b.ts", key: "20.z" });
  });
});

describe("paneModel", () => {
  const base = numbered(40);
  const agent = replaceLine(replaceLine(base, 5, "agent 5"), 30, "agent 30");
  const [first, second] = computeBlocks(base, agent)!.blocks;
  const asGhost = (b: typeof first, extra: Partial<RevertedBlock> = {}): RevertedBlock => ({
    key: b!.key, rows: b!.rows, oldFrom: b!.oldFrom, oldTo: b!.oldTo, added: b!.added, removed: b!.removed, base: "b1", drawnVersion: "v1", ...extra,
  });

  it("draws blocks with the unchanged lines between them", () => {
    const model = paneModel({ original: base, modified: agent, version: "v1", base: "b1", kept: new Set([first!.key]), reverted: [] })!;
    expect(model.items.map((i) => (i.kind === "gap" ? `gap ${i.from}-${i.to}` : `${i.state} ${i.index}`))).toEqual([
      "gap 0-1", "kept 0", "gap 8-26", "open 1", "gap 33-40",
    ]);
    expect(model.total).toBe(2);
    expect(model.lines[4]).toBe("agent 5");
    expect(model.baseLine[0]).toBe(1);
    expect(model.baseLine[4]).toBe(0);
  });

  it("keeps a reverted block where its lines are now, once the file is redrawn", () => {
    const now = revertBlocks(base, agent, [second!]);
    const model = paneModel({ original: base, modified: now, version: "v2", base: "b1", kept: new Set(), reverted: [asGhost(second, { undoId: "u1" })] })!;
    const blocks = model.items.filter((i) => i.kind === "block");
    expect(blocks.map((b) => [b.key, b.state, b.index])).toEqual([[first!.key, "open", 0], [second!.key, "reverted", 1]]);
    expect(blocks[1]).toMatchObject({ undoId: "u1" });
    expect(model.stale).toEqual([]);
    // No unchanged line is drawn twice: the reverted block's lines are not in a gap too.
    const gaps = model.items.filter((i) => i.kind === "gap").reduce((n, g) => n + g.to - g.from, 0);
    expect(gaps + 7 + 7).toBe(40);
  });

  it("keeps the calls a reverted block named, so its turns stay on it", () => {
    const calls = (m: ReturnType<typeof paneModel>) => m!.items.filter((i) => i.kind === "block").map((b) => b.calls);
    // Still in the diff on screen, which predates the revert: the list no longer names it.
    const drawn = paneModel({ original: base, modified: agent, version: "v1", base: "b1", kept: new Set(), reverted: [asGhost(second, { calls: ["toolu_2"] })] });
    expect(calls(drawn)).toEqual([undefined, ["toolu_2"]]);
    // Redrawn: kept in place from what was reverted.
    const now = revertBlocks(base, agent, [second!]);
    const redrawn = paneModel({ original: base, modified: now, version: "v2", base: "b1", kept: new Set(), reverted: [asGhost(second, { calls: ["toolu_2"] })] });
    expect(calls(redrawn)).toEqual([undefined, ["toolu_2"]]);
  });

  it("shows a block as reverted while the diff on screen predates the revert", () => {
    const model = paneModel({ original: base, modified: agent, version: "v1", base: "b1", kept: new Set(), reverted: [asGhost(second)] })!;
    expect(model.items.filter((i) => i.kind === "block").map((b) => b.state)).toEqual(["open", "reverted"]);
  });

  it("lets go of a reverted block the agent wrote over, or one cut against another base", () => {
    const rewritten = replaceLine(revertBlocks(base, agent, [second!]), 30, "agent again");
    expect(paneModel({ original: base, modified: rewritten, version: "v3", base: "b1", kept: new Set(), reverted: [asGhost(second)] })!.stale).toEqual([second!.key]);
    const moved = revertBlocks(base, agent, [second!]);
    expect(paneModel({ original: base, modified: moved, version: "v2", base: "b2", kept: new Set(), reverted: [asGhost(second)] })!.stale).toEqual([second!.key]);
  });

  it("shows an answer on its way", () => {
    const model = paneModel({ original: base, modified: agent, version: "v1", base: "b1", kept: new Set(), reverted: [], pending: new Map([[first!.key, "kept"]]) })!;
    expect(model.items.filter((i) => i.kind === "block").map((b) => b.state)).toEqual(["kept", "open"]);
  });

  it("draws a file whose every change was reverted, from the text it is back to", () => {
    const model = paneModel({ original: base, modified: base, version: "", base: "b1", kept: new Set(), reverted: [asGhost(first), asGhost(second)] })!;
    expect(model.items.filter((i) => i.kind === "block").map((b) => b.state)).toEqual(["reverted", "reverted"]);
  });
});

describe("rows", () => {
  it("shows the lines that stay once a block is answered", () => {
    const [block] = computeBlocks("a\nold\nb\n", "a\nnew\nb\n")!.blocks;
    expect(shownRows(block!.rows, "kept").map((r) => r.text)).toEqual(["a", "new", "b"]);
    expect(shownRows(block!.rows, "reverted").map((r) => r.text)).toEqual(["a", "old", "b"]);
    expect(shownRows(block!.rows, "open")).toHaveLength(4);
  });

  it("marks the changed part of a paired line, widened to whole words", () => {
    const [block] = computeBlocks("const limit = 5;\n", "const limit = max(5);\n")!.blocks;
    const spans = changedSpans(block!.rows);
    expect(spans).toEqual([[14, 15], [14, 20]]);
    // A line with no partner is all change, which the row's colour already says.
    const [lone] = computeBlocks("a\n", "a\nb\n")!.blocks;
    expect(changedSpans(lone!.rows)).toEqual([null, null]);
  });
});
