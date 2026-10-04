/**
 * The Review changes tab as pure functions: each changed file's blocks in the
 * order they sit in the file, the unchanged stretches between them, the rail's
 * groups, the progress strip, and where J/K and an answer move the focus.
 *
 * A block is one hunk of one of two diffs — HEAD → index (staged) or index →
 * working tree (open) — or a discard made from the tab, which git no longer
 * lists but the tab keeps in place with its Undo. All three are placed by the
 * one coordinate they share, the line in the index version of the file
 * (`blockAnchor`), which is what lets a file show them as one list.
 *
 * Kept out of the components so it can be tested directly: importing them
 * pulls in the zustand stores, which read `localStorage` at module scope.
 */
import {
  blockAnchor,
  type ChangeBlock,
  type ChangedFile,
  type ChangeHunk,
  type ChangeLine,
  type ChangeSideName,
  type FileChangeDetail,
  type WholeReason,
} from "../../shared/git-changes";

export type ReviewBlockState = "open" | "staged" | "discarded";

/** Why a block stands for the whole file: git's reason, or a file deleted outright. */
export type WholeKind = WholeReason | "deleted";

/** A run of a hunk's lines, with the numbers its first line has on each side. */
export interface BlockPart {
  oldStart: number;
  newStart: number;
  lines: ChangeLine[];
}

export interface ReviewBlock {
  /**
   * `u:`/`s:` and the hunk's fingerprint (`#2` for a second identical hunk),
   * `d:` and the discard's record: stable for as long as the content is.
   */
  key: string;
  state: ReviewBlockState;
  /** The diff it is part of; a discarded block was part of the unstaged one. */
  side: ChangeSideName;
  /** Position and fingerprint for the hunk routes. Null for a whole-file block. */
  hunk: ChangeBlock | null;
  whole: WholeKind | null;
  /** Its lines: null until the file's detail has loaded, and for a whole file with none to show. */
  parts: BlockPart[] | null;
  /** The index line it sits at. */
  anchor: number;
  /** The index lines it spans, both inclusive; `last < first` when it spans none. */
  first: number;
  last: number;
  added: number;
  removed: number;
  /** A discard's journal record, which Undo restores. */
  recordId?: string;
}

/** A discard made from the tab: git no longer lists it, so the tab keeps it, with Undo. */
export interface DiscardedEntry {
  path: string;
  recordId: string;
  /** What went, as the tab showed it (old side = the index). Empty when it went as a whole file. */
  hunks: ChangeHunk[];
  /** Set when it went whole: why the tab showed it as one block. */
  whole: WholeKind | null;
  added: number;
  removed: number;
}

/** What an action in flight is expected to make of a block, shown before git confirms it. */
export type PendingStates = ReadonlyMap<string, ReviewBlockState>;

/** Keys repeat across files (`u:whole`, and the same edit in two files), so state is held per path. */
export const blockId = (path: string, key: string) => `${path}\0${key}`;

type SideBlock = ChangeBlock & { lines?: ChangeLine[] };

interface SideLike {
  whole?: WholeReason;
  added: number;
  removed: number;
  blocks: SideBlock[];
}

const toPart = (b: SideBlock & { lines: ChangeLine[] }): BlockPart => ({ oldStart: b.oldStart, newStart: b.newStart, lines: b.lines });

const bare = (b: ChangeBlock): ChangeBlock => ({
  id: b.id,
  index: b.index,
  oldStart: b.oldStart,
  oldLines: b.oldLines,
  newStart: b.newStart,
  newLines: b.newLines,
  added: b.added,
  removed: b.removed,
});

/** The index lines a hunk spans on `side`: a hunk with none sits after the line its start names. */
function indexSpan(side: ChangeSideName, b: ChangeBlock): { anchor: number; first: number; last: number } {
  const [start, count] = side === "staged" ? [b.newStart, b.newLines] : [b.oldStart, b.oldLines];
  return { anchor: blockAnchor(side, b), first: count ? start : start + 1, last: count ? start + count - 1 : start };
}

function sideBlocks(name: ChangeSideName, side: SideLike | null, deleted: boolean, withLines: boolean): ReviewBlock[] {
  if (!side) return [];
  const prefix = name === "staged" ? "s" : "u";
  const state: ReviewBlockState = name === "staged" ? "staged" : "open";
  if (side.whole || deleted || !side.blocks.length) {
    const whole: WholeKind = deleted ? "deleted" : side.whole ?? "empty";
    // A rename's edits are listed, though git takes the rename as one change.
    const shown = withLines && whole === "rename" && side.blocks.every((b) => b.lines);
    return [{
      key: `${prefix}:whole`,
      state,
      side: name,
      hunk: null,
      whole,
      parts: shown && side.blocks.length ? side.blocks.map((b) => toPart(b as SideBlock & { lines: ChangeLine[] })) : null,
      anchor: 0,
      first: 1,
      last: 0,
      added: side.added,
      removed: side.removed,
    }];
  }
  const seen = new Map<string, number>();
  return side.blocks.map((b) => {
    const n = (seen.get(b.id) ?? 0) + 1;
    seen.set(b.id, n);
    return {
      key: `${prefix}:${b.id}${n > 1 ? `#${n}` : ""}`,
      state,
      side: name,
      hunk: bare(b),
      whole: null,
      parts: withLines && b.lines ? [toPart(b as SideBlock & { lines: ChangeLine[] })] : null,
      ...indexSpan(name, b),
      added: b.added,
      removed: b.removed,
    };
  });
}

function discardBlocks(entry: DiscardedEntry): ReviewBlock[] {
  if (entry.whole || !entry.hunks.length) {
    return [{
      key: `d:${entry.recordId}`,
      state: "discarded",
      side: "unstaged",
      hunk: null,
      whole: entry.whole ?? "empty",
      parts: null,
      anchor: 0,
      first: 1,
      last: 0,
      added: entry.added,
      removed: entry.removed,
      recordId: entry.recordId,
    }];
  }
  return entry.hunks.map((h, i) => ({
    key: `d:${entry.recordId}:${i}`,
    state: "discarded",
    side: "unstaged",
    hunk: bare(h),
    whole: null,
    parts: [toPart(h)],
    ...indexSpan("unstaged", h),
    added: h.added,
    removed: h.removed,
    recordId: entry.recordId,
  }));
}

const RANK: Record<ReviewBlockState, number> = { staged: 0, open: 1, discarded: 2 };

/**
 * One file's blocks in file order: staged and open ones from the detail when
 * it has loaded (the list otherwise, without lines), then this tab's discards.
 *
 * `pending` overrides a block's state while the action that will change it is
 * in flight. A block being discarded is dropped once its discard is recorded,
 * so the two never show at once while git's answer is still on its way.
 */
export function fileBlocks(p: {
  path: string;
  file: ChangedFile | null;
  detail: FileChangeDetail | null;
  discards: readonly DiscardedEntry[];
  pending: PendingStates;
}): ReviewBlock[] {
  const out: ReviewBlock[] = [];
  // Only a file git still lists has live blocks: a detail outliving it would be a stale one.
  if (p.file) {
    const src = p.detail ?? p.file;
    const withLines = !!p.detail;
    const staged: SideLike | null = p.detail
      ? p.detail.staged && { whole: p.detail.staged.whole, added: p.detail.staged.added, removed: p.detail.staged.removed, blocks: p.detail.staged.hunks }
      : p.file.staged;
    const unstaged: SideLike | null = p.detail
      ? p.detail.unstaged && { whole: p.detail.unstaged.whole, added: p.detail.unstaged.added, removed: p.detail.unstaged.removed, blocks: p.detail.unstaged.hunks }
      : p.file.unstaged;
    const live = [
      ...sideBlocks("staged", staged, src.x === "D", withLines),
      ...sideBlocks("unstaged", unstaged, src.y === "D", withLines),
    ];
    for (const block of live) {
      const pending = p.pending.get(blockId(p.path, block.key));
      if (pending === "discarded" && covered(block, p.discards)) continue;
      out.push(pending ? { ...block, state: pending } : block);
    }
  }
  for (const entry of p.discards) out.push(...discardBlocks(entry));
  return out
    .map((block, i) => ({ block, i }))
    .sort((a, b) => a.block.anchor - b.block.anchor || RANK[a.block.state] - RANK[b.block.state] || a.i - b.i)
    .map(({ block }) => block);
}

/** A discard already recorded for this block, which then stands in for it. */
function covered(block: ReviewBlock, discards: readonly DiscardedEntry[]): boolean {
  if (!block.hunk) return discards.some((d) => d.whole || !d.hunks.length);
  return discards.some((d) => d.hunks.some((h) => h.id === block.hunk!.id && h.oldStart === block.hunk!.oldStart));
}

export interface FileReview {
  path: string;
  /** What `GET /git/changes` lists for it; null once only the tab's discards are left of it. */
  file: ChangedFile | null;
  blocks: ReviewBlock[];
  open: number;
  staged: number;
  discarded: number;
  /** Over the blocks still in the file: open and staged. */
  added: number;
  removed: number;
}

function summarize(path: string, file: ChangedFile | null, blocks: ReviewBlock[]): FileReview {
  const review: FileReview = { path, file, blocks, open: 0, staged: 0, discarded: 0, added: 0, removed: 0 };
  for (const b of blocks) {
    review[b.state === "open" ? "open" : b.state === "staged" ? "staged" : "discarded"]++;
    if (b.state === "discarded") continue;
    review.added += b.added;
    review.removed += b.removed;
  }
  return review;
}

/**
 * Every file the tab reviews, in git's order, then the files only discards are
 * left of. Conflicts are not among them: a conflict has no blocks until it is
 * resolved, and staging one marks it resolved.
 */
export function fileReviews(p: {
  files: readonly ChangedFile[];
  details: ReadonlyMap<string, FileChangeDetail>;
  discards: readonly DiscardedEntry[];
  pending: PendingStates;
}): FileReview[] {
  const byPath = new Map<string, DiscardedEntry[]>();
  for (const d of p.discards) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d]);
  const out: FileReview[] = [];
  const listed = new Set<string>();
  for (const file of p.files) {
    if (file.conflict) continue;
    listed.add(file.path);
    const blocks = fileBlocks({ path: file.path, file, detail: p.details.get(file.path) ?? null, discards: byPath.get(file.path) ?? [], pending: p.pending });
    if (blocks.length) out.push(summarize(file.path, file, blocks));
  }
  const gone = [...byPath.keys()].filter((path) => !listed.has(path)).sort();
  for (const path of gone) {
    out.push(summarize(path, null, fileBlocks({ path, file: null, detail: null, discards: byPath.get(path)!, pending: p.pending })));
  }
  return out;
}

export type RailGroup = "changes" | "staged" | "discarded";

/** Changes while something is left to decide, Staged once the rest is all staged, Discarded once nothing is left. */
export function railGroup(review: FileReview): RailGroup {
  if (review.open) return "changes";
  return review.staged ? "staged" : "discarded";
}

const GROUP_ORDER: RailGroup[] = ["changes", "staged", "discarded"];

/** The rail's order, which is also the order J and K walk. */
export function railOrder(reviews: readonly FileReview[]): FileReview[] {
  return GROUP_ORDER.flatMap((g) => reviews.filter((r) => railGroup(r) === g));
}

export interface ReviewTotals {
  /** Files with something still in them. */
  files: number;
  /** Open and staged: what is still a change. */
  blocks: number;
  staged: number;
  discarded: number;
  added: number;
  removed: number;
}

export function reviewTotals(reviews: readonly FileReview[]): ReviewTotals {
  const t: ReviewTotals = { files: 0, blocks: 0, staged: 0, discarded: 0, added: 0, removed: 0 };
  for (const r of reviews) {
    if (r.open + r.staged) t.files++;
    t.blocks += r.open + r.staged;
    t.staged += r.staged;
    t.discarded += r.discarded;
    t.added += r.added;
    t.removed += r.removed;
  }
  return t;
}

export interface ReviewFocus {
  path: string;
  key: string;
}

function sequence(reviews: readonly FileReview[]): { path: string; block: ReviewBlock }[] {
  return railOrder(reviews).flatMap((r) => r.blocks.map((block) => ({ path: r.path, block })));
}

const at = (focus: ReviewFocus | null) => (e: { path: string; block: ReviewBlock }) =>
  !!focus && e.path === focus.path && e.block.key === focus.key;

/** J and K: the block after or before, across files, stopping at either end. */
export function stepFocus(reviews: readonly FileReview[], from: ReviewFocus | null, dir: 1 | -1): ReviewFocus | null {
  const seq = sequence(reviews);
  if (!seq.length) return null;
  const i = seq.findIndex(at(from));
  const e = i < 0 ? seq[0]! : seq[Math.max(0, Math.min(seq.length - 1, i + dir))]!;
  return { path: e.path, key: e.block.key };
}

/**
 * Where an answer moves on to: the next block nobody has decided yet, wrapping
 * round, never `from` itself. Walked in the list's own order, not the rail's:
 * answering a file's last open block moves it under Staged, and from there the
 * rail would wrap round to the first file instead of going on to the next.
 */
export function nextOpen(reviews: readonly FileReview[], from: ReviewFocus | null): ReviewFocus | null {
  const seq = reviews.flatMap((r) => r.blocks.map((block) => ({ path: r.path, block })));
  const i = seq.findIndex(at(from));
  for (let k = 1; k <= seq.length; k++) {
    const e = seq[(i + k + seq.length) % seq.length]!;
    if (e.block.state === "open" && !at(from)(e)) return { path: e.path, key: e.block.key };
  }
  return null;
}

/** Opening a file: its first open block, else its first. */
export function firstInFile(review: FileReview): ReviewFocus | null {
  const block = review.blocks.find((b) => b.state === "open") ?? review.blocks[0];
  return block ? { path: review.path, key: block.key } : null;
}

/** Next file: the next one with an open block after `path`, wrapping; failing that, simply the next file. */
export function nextFileFocus(reviews: readonly FileReview[], path: string | null): ReviewFocus | null {
  const order = railOrder(reviews);
  const i = order.findIndex((r) => r.path === path);
  for (let k = 1; k <= order.length; k++) {
    const r = order[(i + k + order.length) % order.length]!;
    const open = r.blocks.find((b) => b.state === "open");
    if (open && r.path !== path) return { path: r.path, key: open.key };
  }
  const next = order[(i + 1) % Math.max(order.length, 1)];
  return next && next.path !== path ? firstInFile(next) : null;
}

/**
 * Keeps the focus on something that exists after git answered. A block whose
 * content changed gets a new key — an unstaged block staged, part of a block
 * staged by line — so the nearest block of the same file takes its place, an
 * open one first; a file with nothing left hands over to the next open block.
 */
export function resolveFocus(
  reviews: readonly FileReview[],
  want: (ReviewFocus & { anchor?: number }) | null,
): ReviewFocus | null {
  if (want) {
    const file = reviews.find((r) => r.path === want.path);
    if (file?.blocks.some((b) => b.key === want.key)) return { path: want.path, key: want.key };
    if (file?.blocks.length) {
      const anchor = want.anchor ?? 0;
      const near = [...file.blocks].sort((a, b) =>
        (a.state === "open" ? 0 : 1) - (b.state === "open" ? 0 : 1) || Math.abs(a.anchor - anchor) - Math.abs(b.anchor - anchor),
      )[0]!;
      return { path: want.path, key: near.key };
    }
  }
  const seq = sequence(reviews);
  const e = seq.find((x) => x.block.state === "open") ?? seq[0];
  return e ? { path: e.path, key: e.block.key } : null;
}

export type PaneItem =
  | { kind: "gap"; key: string; lines: number }
  | { kind: "block"; block: ReviewBlock; index: number; total: number };

/**
 * A file's blocks with the unchanged stretches between them. Staged and open
 * blocks come from two diffs, so their context lines can overlap; a stretch is
 * only counted where neither covers it.
 */
export function paneItems(blocks: readonly ReviewBlock[]): PaneItem[] {
  const items: PaneItem[] = [];
  let end = 0;
  blocks.forEach((block, index) => {
    if (!block.whole) {
      const gap = block.first - end - 1;
      if (gap > 0) items.push({ kind: "gap", key: `gap:${block.key}`, lines: gap });
      end = Math.max(end, block.last);
    }
    items.push({ kind: "block", block, index, total: blocks.length });
  });
  return items;
}

export interface ReviewRow {
  kind: ChangeLine["kind"];
  text: string;
  old: number | null;
  new: number | null;
  /** Its index among the hunk's lines: what a line pick sends. */
  at: number;
}

/** A part's lines with their numbers on each side. */
export function numberedRows(part: BlockPart): ReviewRow[] {
  let o = part.oldStart;
  let n = part.newStart;
  return part.lines.map((line, at) => ({
    kind: line.kind,
    text: line.text,
    old: line.kind === "+" ? null : o++,
    new: line.kind === "-" ? null : n++,
    at,
  }));
}

/** "Lines 12–20", "Line 7", "Lines 30–31, removed": where the block is, on the side it leaves behind. */
export function rangeText(block: ReviewBlock): string {
  const part = block.parts?.[0];
  if (block.whole || !part) return "Whole file";
  const span = (start: number, n: number) => (n > 1 ? `Lines ${start}–${start + n - 1}` : `Line ${start}`);
  const oldLines = part.lines.filter((l) => l.kind !== "+").length;
  const newLines = part.lines.filter((l) => l.kind !== "-").length;
  // A discarded block's new side is gone: what is left of it is the old one.
  if (block.state === "discarded") return oldLines ? span(part.oldStart, oldLines) : "Whole file";
  return newLines ? span(part.newStart, newLines) : `${span(part.oldStart, oldLines)}, removed`;
}

/** The lines a pick can tick: the changed ones. */
export function pickableLines(block: ReviewBlock): number[] {
  const lines = block.parts?.[0]?.lines ?? [];
  return lines.flatMap((l, i) => (l.kind === " " ? [] : [i]));
}

/**
 * Which of a hunk's lines to send for a pick. Null when the pick is the whole
 * block, which is then staged as one — the same change, without the line
 * surgery.
 */
export function pickRequest(block: ReviewBlock, picked: ReadonlySet<number>): number[] | null {
  const lines = pickableLines(block).filter((i) => picked.has(i));
  return lines.length === pickableLines(block).length ? null : lines;
}

/**
 * Where the k-th copy of a hunk sits in a fresh list: what a request names it
 * by, since an earlier block answered in the same file moves every later one.
 */
export function hunkIndex(hunks: readonly ChangeBlock[], key: string): number | null {
  const m = /^[us]:([^#]+)(?:#(\d+))?$/.exec(key);
  if (!m) return null;
  let left = Number(m[2] ?? 1);
  for (const h of hunks) if (h.id === m[1] && --left === 0) return h.index;
  return null;
}

/**
 * A list entry reduced to what decides whether its detail is still current:
 * its letters and, per side, which blocks it has.
 */
export function fileSignature(file: ChangedFile): string {
  const side = (s: ChangedFile["staged"]) => (s ? `${s.whole ?? ""}:${s.blocks.map((b) => b.id).join(",")}` : "-");
  return `${file.x}${file.y}|${file.oldPath ?? ""}|${side(file.staged)}|${side(file.unstaged)}`;
}
