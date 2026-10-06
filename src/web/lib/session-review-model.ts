/**
 * The pure half of the block-by-block Review tab: which blocks each file has and how each was
 * answered, where a block reverted in this sitting still sits in the file, and where focus goes
 * after an answer. No I/O and no stores, so it runs under `bun:test`.
 *
 * The server's list names every block of every file by key and says which are kept. A block
 * reverted here is no longer a change at all — its lines are back on disk — so the list forgets
 * it. The tab keeps it (`RevertedBlock`) while it is open and shows it where it sits, as the
 * lines it put back: what stays is what a decided block shows, kept or reverted.
 */
import { blockStart, computeBlocks, lineMap, splitLines, type BlockDiff, type ReviewRow } from "../../shared/review-blocks";
import type { SessionFileChange } from "../../shared/session-file-changes";

export type BlockState = "open" | "kept" | "reverted";

/** The key of the one block a file answered whole has: binary, too large, or too slow to diff. */
export const WHOLE_FILE = "*";

export interface Focus {
  path: string;
  key: string;
}

/** A block reverted in this sitting. */
export interface RevertedBlock {
  key: string;
  /** Its rows as drawn: what the revert took away, and what it put back. */
  rows: ReviewRow[];
  /** The base lines it covers, which the revert put back: 0-based, end exclusive. */
  oldFrom: number;
  oldTo: number;
  added: number;
  removed: number;
  /** What the block was cut against (`SessionFileChange.base`). */
  base: string;
  /** The file's version when the block was drawn: a diff still at it was read before the revert. */
  drawnVersion: string;
  /** Names the revert for Undo; absent until the server has answered. */
  undoId?: string;
  /** The calls that wrote it, as the list named them while it was there. */
  calls?: readonly string[];
}

/** A file no longer listed because every change in it was reverted here. */
export interface RevertedFile {
  /** As it was last drawn. */
  file: SessionFileChange;
  /** The text it is back to, which is also what it was compared with; null for one answered whole. */
  text: string | null;
  /** Names the revert for Undo. */
  undoId?: string;
}

export interface FileReview {
  path: string;
  file: SessionFileChange;
  /** In file order. A file answered whole has one block, keyed `WHOLE_FILE`. */
  blocks: { key: string; state: BlockState }[];
  open: number;
  /** Every change in it was reverted here: the server no longer lists it. */
  gone: boolean;
}

/** Answers on their way to the server, by `answerKey`: shown at once, replaced by the answer. */
export type PendingStates = ReadonlyMap<string, BlockState>;

export const answerKey = (path: string, key: string) => `${path}\0${key}`;

/**
 * Every file of the review in `order` — the order paths were first seen in, so a file whose
 * changes were all reverted keeps its place — with each block's state.
 */
export function fileReviews(p: {
  order: readonly string[];
  files: readonly SessionFileChange[];
  reverted: ReadonlyMap<string, readonly RevertedBlock[]>;
  gone: ReadonlyMap<string, RevertedFile>;
  pending?: PendingStates;
}): FileReview[] {
  const listed = new Map(p.files.map((f) => [f.path, f]));
  const out: FileReview[] = [];
  for (const path of p.order) {
    const file = listed.get(path);
    const gone = !file ? p.gone.get(path) : undefined;
    if (!file && !gone) continue;
    const ghosts = p.reverted.get(path) ?? [];
    let blocks: { key: string; state: BlockState; at: number }[];
    if (file) {
      blocks = file.blocks
        ? file.blocks.map((b) => ({ key: b.key, state: (b.kept ? "kept" : "open") as BlockState, at: blockStart(b.key) }))
        : [{ key: WHOLE_FILE, state: file.reviewed ? "kept" : "open", at: 0 }];
      const keys = new Map(blocks.map((b) => [b.key, b]));
      for (const g of ghosts) {
        if (g.base !== file.base) continue;
        const listedBlock = keys.get(g.key);
        // Still listed: either the list was read before the revert, or the agent wrote the lines again.
        if (listedBlock) {
          if (file.version === g.drawnVersion) listedBlock.state = "reverted";
        } else {
          blocks.push({ key: g.key, state: "reverted", at: g.oldFrom });
        }
      }
    } else {
      blocks = ghosts.length
        ? ghosts.map((g) => ({ key: g.key, state: "reverted" as BlockState, at: g.oldFrom }))
        : [{ key: WHOLE_FILE, state: "reverted", at: 0 }];
    }
    blocks.sort((a, b) => a.at - b.at);
    const states = blocks.map((b) => ({ key: b.key, state: p.pending?.get(answerKey(path, b.key)) ?? b.state }));
    out.push({
      path,
      file: file ?? gone!.file,
      blocks: states,
      open: states.filter((b) => b.state === "open").length,
      gone: !file,
    });
  }
  return out;
}

export function reviewProgress(reviews: readonly FileReview[]): { total: number; kept: number; reverted: number; open: number } {
  let kept = 0;
  let reverted = 0;
  let open = 0;
  for (const r of reviews) {
    for (const b of r.blocks) {
      if (b.state === "kept") kept++;
      else if (b.state === "reverted") reverted++;
      else open++;
    }
  }
  return { total: kept + reverted + open, kept, reverted, open };
}

/** Files with a block left to answer first, then the ones that are done: the rail's order. */
export function railOrder(reviews: readonly FileReview[]): FileReview[] {
  return [...reviews.filter((r) => r.open > 0), ...reviews.filter((r) => r.open === 0)];
}

/** How a finished file ended, as the rail says it. */
export function fileOutcome(r: FileReview): { tone: "kept" | "reverted" | "mixed"; label: string } {
  const kept = r.blocks.filter((b) => b.state === "kept").length;
  const reverted = r.blocks.length - kept;
  if (!reverted) return { tone: "kept", label: "Kept" };
  if (!kept) return { tone: "reverted", label: "Reverted" };
  return { tone: "mixed", label: `${kept} kept · ${reverted} reverted` };
}

/**
 * The next open block after `from`: the rest of its file first, then the files after it,
 * wrapping round, and last the blocks before it in its own file. Null when none is open.
 */
export function nextOpen(reviews: readonly FileReview[], from: Focus | null): Focus | null {
  if (reviews.length === 0) return null;
  const start = from ? Math.max(0, reviews.findIndex((r) => r.path === from.path)) : 0;
  const own = reviews[start]!;
  const at = from && own.path === from.path ? own.blocks.findIndex((b) => b.key === from.key) : -1;
  for (let n = 0; n < reviews.length; n++) {
    const r = reviews[(start + n) % reviews.length]!;
    const first = n === 0 ? at + 1 : 0;
    for (let i = first; i < r.blocks.length; i++) if (r.blocks[i]!.state === "open") return { path: r.path, key: r.blocks[i]!.key };
  }
  for (let i = 0; i <= at; i++) if (own.blocks[i]!.state === "open") return { path: own.path, key: own.blocks[i]!.key };
  return null;
}

/** The block `step` places from `from` among every block, in the rail's order, wrapping. */
export function stepBlock(reviews: readonly FileReview[], from: Focus | null, step: 1 | -1): Focus | null {
  const all = railOrder(reviews).flatMap((r) => r.blocks.map((b) => ({ path: r.path, key: b.key })));
  if (all.length === 0) return null;
  const i = from ? all.findIndex((b) => b.path === from.path && b.key === from.key) : -1;
  if (i < 0) return all[step === 1 ? 0 : all.length - 1]!;
  return all[(i + step + all.length) % all.length]!;
}

/** Where focus lands in a file: its first open block, else its first block. */
export function firstInFile(review: FileReview): Focus | null {
  const block = review.blocks.find((b) => b.state === "open") ?? review.blocks[0];
  return block ? { path: review.path, key: block.key } : null;
}

export type PaneItem =
  | {
      kind: "block";
      key: string;
      rows: ReviewRow[];
      state: BlockState;
      added: number;
      removed: number;
      /** The base lines it covers: 0-based, end exclusive. */
      oldFrom: number;
      oldTo: number;
      /** 0-based place among the file's blocks. */
      index: number;
      undoId?: string;
      /** The calls that wrote it (`SessionBlockSummary.calls`), for the turns it names. */
      calls?: readonly string[];
    }
  /** Unchanged lines of the file as it is now: 0-based, end exclusive. */
  | { kind: "gap"; from: number; to: number };

export interface PaneModel {
  items: PaneItem[];
  /** The file as it is now, line by line, for the unchanged lines a gap opens up. */
  lines: string[];
  /** Each line's number in the base, 1-based, or 0 for one that is not there. */
  baseLine: Int32Array;
  /** How many blocks the file has, reverted ones included. */
  total: number;
  /** Reverted blocks that no longer belong here: the agent wrote over them, or the base moved. */
  stale: string[];
}

/**
 * The file in focus as the pane draws it: its blocks — each open, kept or reverted — with the
 * unchanged lines between them. Null when the diff is too slow to cut into blocks.
 */
export function paneModel(p: {
  original: string;
  modified: string;
  version: string;
  base?: string;
  /** Keys of the blocks kept, as the diff's own summary says. */
  kept: ReadonlySet<string>;
  reverted: readonly RevertedBlock[];
  /** Answers on their way, by block key. */
  pending?: ReadonlyMap<string, BlockState>;
  /** The calls that wrote each block, by key, as the list says. */
  calls?: ReadonlyMap<string, readonly string[]>;
}): PaneModel | null {
  const cut = cutFile(p.original, p.modified);
  if (!cut) return null;
  const { diff, map } = cut;
  type Entry = Omit<Extract<PaneItem, { kind: "block" }>, "index" | "kind"> & { start: number; end: number };
  const entries: Entry[] = [];
  const stale: string[] = [];
  const ghosts = new Map(p.reverted.map((g) => [g.key, g]));
  const keys = new Set<string>();
  for (const b of diff.blocks) {
    keys.add(b.key);
    const ghost = ghosts.get(b.key);
    let state: BlockState = p.kept.has(b.key) ? "kept" : "open";
    const calls = p.calls?.get(b.key) ?? ghost?.calls;
    if (ghost) {
      // Read before the revert landed; otherwise the agent wrote these lines again since.
      if (ghost.drawnVersion === p.version) state = "reverted";
      else stale.push(ghost.key);
    }
    entries.push({
      key: b.key,
      rows: b.rows,
      state,
      added: b.added,
      removed: b.removed,
      oldFrom: b.oldFrom,
      oldTo: b.oldTo,
      start: b.newFrom,
      end: b.newTo,
      ...(ghost?.drawnVersion === p.version && ghost.undoId ? { undoId: ghost.undoId } : {}),
      ...(calls ? { calls } : {}),
    });
  }
  for (const g of p.reverted) {
    if (keys.has(g.key)) continue;
    const start = g.base === p.base ? placeReverted(g, map, p.original) : -1;
    const end = start + (g.oldTo - g.oldFrom);
    if (start < 0 || entries.some((e) => e.start < end && start < e.end)) {
      stale.push(g.key);
      continue;
    }
    entries.push({
      key: g.key,
      rows: g.rows,
      state: "reverted",
      added: g.added,
      removed: g.removed,
      oldFrom: g.oldFrom,
      oldTo: g.oldTo,
      start,
      end,
      ...(g.undoId ? { undoId: g.undoId } : {}),
      ...(g.calls ? { calls: g.calls } : {}),
    });
  }
  entries.sort((a, b) => a.start - b.start || a.end - b.end);

  const items: PaneItem[] = [];
  let cursor = 0;
  entries.forEach(({ start, end, ...e }, index) => {
    if (start > cursor) items.push({ kind: "gap", from: cursor, to: start });
    items.push({ kind: "block", ...e, state: p.pending?.get(e.key) ?? e.state, index });
    cursor = Math.max(cursor, end);
  });
  if (cursor < diff.newLines) items.push({ kind: "gap", from: cursor, to: diff.newLines });

  return { items, lines: cut.lines, baseLine: cut.baseLine, total: entries.length, stale };
}

interface Cut {
  original: string;
  modified: string;
  diff: BlockDiff;
  map: Int32Array;
  lines: string[];
  baseLine: Int32Array;
}

// The pane is redrawn on every answer while its file stays the same, and a diff that ran out of
// time would otherwise run out of time again each time: the last few files are kept, failures too.
const cuts: { original: string; modified: string; cut: Cut | null }[] = [];
const CUTS_KEPT = 4;

function cutFile(original: string, modified: string): Cut | null {
  const hit = cuts.find((c) => c.original === original && c.modified === modified);
  if (hit) return hit.cut;
  const diff = computeBlocks(original, modified);
  const map = diff && lineMap(original, modified);
  let cut: Cut | null = null;
  if (diff && map) {
    const baseLine = new Int32Array(diff.newLines);
    map.forEach((n, o) => { if (n >= 0) baseLine[n] = o + 1; });
    const lines = splitLines(modified).map((l) => l.replace(/\r?\n$/, ""));
    cut = { original, modified, diff, map, lines, baseLine };
  }
  cuts.unshift({ original, modified, cut });
  cuts.length = Math.min(cuts.length, CUTS_KEPT);
  return cut;
}

/** Where a reverted block's base lines sit in the file now, or -1 when they are not all there, in order. */
function placeReverted(g: RevertedBlock, map: Int32Array, original: string): number {
  if (g.oldFrom === g.oldTo) return original === "" ? 0 : -1;
  const start = map[g.oldFrom] ?? -1;
  if (start < 0) return -1;
  for (let i = g.oldFrom; i < g.oldTo; i++) if (map[i] !== start + i - g.oldFrom) return -1;
  return start;
}

/** The rows a block shows: the diff while it is open, the lines that stay once it is answered. */
export function shownRows(rows: readonly ReviewRow[], state: BlockState): ReviewRow[] {
  if (state === "kept") return rows.filter((r) => r.k !== "-");
  if (state === "reverted") return rows.filter((r) => r.k !== "+");
  return [...rows];
}

const WORD = /[\w$]/;

/**
 * The part of each changed line that changed, where a removed line and an added one pair up
 * (the n-th removed line of a run with the n-th added line after it): between their common
 * start and end, widened to whole words. Null for a line with no partner.
 */
export function changedSpans(rows: readonly ReviewRow[]): ([number, number] | null)[] {
  const out: ([number, number] | null)[] = rows.map(() => null);
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.k !== "-") {
      i++;
      continue;
    }
    const del = i;
    while (i < rows.length && rows[i]!.k === "-") i++;
    const add = i;
    while (i < rows.length && rows[i]!.k === "+") i++;
    for (let j = 0; j < Math.min(add - del, i - add); j++) {
      const a = rows[del + j]!.text;
      const b = rows[add + j]!.text;
      let pre = 0;
      while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
      while (pre > 0 && WORD.test(a[pre - 1]!)) pre--;
      let suf = 0;
      while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
      while (suf > 0 && WORD.test(a[a.length - suf]!)) suf--;
      if (a.length - suf > pre) out[del + j] = [pre, a.length - suf];
      if (b.length - suf > pre) out[add + j] = [pre, b.length - suf];
    }
  }
  return out;
}
