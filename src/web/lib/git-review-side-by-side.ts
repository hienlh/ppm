/**
 * The Review changes tab side by side, as pure functions: where each block's
 * bar goes in the whole-file diff (HEAD on the left, the working tree on the
 * right), and which block a line of the right-hand file belongs to.
 *
 * The diff editor numbers the right side by the working tree, but the blocks
 * come from two diffs with their own numbering: an open block's new side *is*
 * the working tree, while a staged block (HEAD → index) and a discarded one
 * (whose old side is the index) are numbered by the index. Those are moved into
 * working-tree lines through the open blocks, which are exactly the
 * differences between the index and the working tree.
 *
 * Kept out of the components so it can be tested directly, like
 * `git-review-model.ts`.
 */
import type { ChangeLine } from "../../shared/git-changes";
import type { ReviewBlock } from "./git-review-model";

/** Whole-file blocks the side-by-side view can place. Any other (binary, rename, …) falls back to the block list. */
const PLACEABLE_WHOLE = new Set(["deleted"]);

/** Whether a file's blocks can be shown side by side, or need the block list. */
export function sideBySideSupported(blocks: readonly ReviewBlock[]): boolean {
  return blocks.length > 0 && blocks.every((b) => !b.whole || PLACEABLE_WHOLE.has(b.whole));
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** When known, the hunk's lines: then lines inside it map exactly. */
  lines?: ChangeLine[];
}

/** The open blocks' hunks (index → working tree) in index order: what moves an index line. */
function worktreeHunks(blocks: readonly ReviewBlock[]): Hunk[] {
  return blocks
    .filter((b) => b.side === "unstaged" && b.state !== "discarded" && b.hunk)
    .map((b) => ({ ...b.hunk!, lines: b.parts?.[0]?.lines }))
    .sort((a, b) => a.oldStart - b.oldStart);
}

/**
 * The working-tree line that index line `line` became. A line the working tree
 * removed maps to where it was: the line that now follows that place.
 */
export function indexToWorktree(line: number, hunks: readonly Hunk[]): number {
  let delta = 0;
  for (const h of hunks) {
    // A hunk with no index lines inserts after `oldStart`.
    if (h.oldLines === 0) {
      if (h.oldStart < line) { delta += h.newLines; continue; }
      break;
    }
    const oldEnd = h.oldStart + h.oldLines - 1;
    if (oldEnd < line) { delta += h.newLines - h.oldLines; continue; }
    if (line < h.oldStart) break;
    // Inside the hunk: walk its lines when they are known, else take its start.
    if (!h.lines) return h.newStart;
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      if (l.kind === "+") { n++; continue; }
      if (o === line) return n;
      o++;
      if (l.kind === " ") n++;
    }
    return n;
  }
  return line + delta;
}

/**
 * Where a block's change starts on the new side of its own diff: the number the
 * first changed line has there, or, for lines only removed, the number of the
 * line that follows them. Without lines, the hunk's start (context included).
 */
function changeTop(block: ReviewBlock): number {
  const part = block.parts?.[0];
  const hunk = block.hunk;
  if (!part) return hunk ? (hunk.newLines ? hunk.newStart : hunk.newStart + 1) : 1;
  let n = part.newStart;
  for (const l of part.lines) {
    if (l.kind !== " ") return n;
    n++;
  }
  return n;
}

/** Where a block's change starts on the old side of its own diff (a discard: its index lines). */
function changeTopOld(block: ReviewBlock): number {
  const part = block.parts?.[0];
  const hunk = block.hunk;
  if (!part) return hunk ? (hunk.oldLines ? hunk.oldStart : hunk.oldStart + 1) : 1;
  let o = part.oldStart;
  for (const l of part.lines) {
    if (l.kind !== " ") return o;
    o++;
  }
  return o;
}

export interface BlockPlace {
  key: string;
  /** The bar goes above this working-tree line (Monaco's `afterLineNumber` is this minus one). */
  line: number;
  /** The working-tree lines the block covers, context included; `last < first` when none. */
  first: number;
  last: number;
}

/** Each block's place in the working tree, in the order the blocks are listed. */
export function placeBlocks(blocks: readonly ReviewBlock[]): BlockPlace[] {
  const hunks = worktreeHunks(blocks);
  return blocks.map((block) => {
    if (block.whole || !block.hunk) return { key: block.key, line: 1, first: 1, last: 0 };
    const h = block.hunk;
    if (block.side === "unstaged" && block.state !== "discarded") {
      return { key: block.key, line: changeTop(block), first: h.newStart, last: h.newStart + h.newLines - 1 };
    }
    // Staged: numbered by the index on its new side. Discarded: by the index on its old side.
    const [top, start, count] = block.state === "discarded"
      ? [changeTopOld(block), h.oldStart, h.oldLines]
      : [changeTop(block), h.newStart, h.newLines];
    const first = indexToWorktree(start, hunks);
    return {
      key: block.key,
      line: indexToWorktree(top, hunks),
      first,
      last: count ? indexToWorktree(start + count - 1, hunks) : first - 1,
    };
  });
}

/** The block a working-tree line belongs to: the innermost one covering it, an open one first. */
export function blockAtLine(blocks: readonly ReviewBlock[], places: readonly BlockPlace[], line: number): string | null {
  let best: { key: string; size: number; open: boolean } | null = null;
  places.forEach((place, i) => {
    if (line < place.first || line > place.last) return;
    const open = blocks[i]?.state === "open";
    const size = place.last - place.first;
    if (!best || (open && !best.open) || (open === best.open && size < best.size)) best = { key: place.key, size, open };
  });
  return (best as { key: string } | null)?.key ?? null;
}
