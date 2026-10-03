/**
 * Change blocks for the session review: the hunks of a line diff between the state a file is
 * compared with (its "before", or the state it was marked reviewed in) and the file now.
 *
 * Shared because both halves need exactly the same blocks: the browser draws them and names
 * the one the user answered by its key, and the server works the blocks out again from the
 * disk before it keeps or reverts anything, so an answer can never land on lines nobody saw.
 *
 * A block is a unified-diff hunk: its changed lines plus up to `BLOCK_CONTEXT` unchanged lines
 * on each side, with changes closer than twice that merged into one block. Its key is its
 * place in the base and its lines, so it survives edits elsewhere in the file (lines above it
 * move its place in the file now, never in the base) and changes the moment the agent touches
 * the block again — which is what reopens a kept block.
 *
 * Lines keep their terminators while blocks are cut and pasted, so a revert puts back the
 * base's exact bytes, CRLF and a missing final newline included; rows drop them for display.
 */
import { diffLines } from "diff";

export type ReviewRowKind = " " | "-" | "+";

export interface ReviewRow {
  k: ReviewRowKind;
  /** The line without its terminator. */
  text: string;
  /** 1-based line number in the base, or null for an added line. */
  o: number | null;
  /** 1-based line number in the file now, or null for a removed line. */
  n: number | null;
}

export interface ReviewBlock {
  key: string;
  /** Line indexes the block covers, context included: 0-based, end exclusive. */
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
  rows: ReviewRow[];
  added: number;
  removed: number;
}

export interface BlockDiff {
  blocks: ReviewBlock[];
  additions: number;
  deletions: number;
  /** Lines in the base and in the file now. */
  oldLines: number;
  newLines: number;
}

/** Unchanged lines shown on each side of a change, as git shows them. */
export const BLOCK_CONTEXT = 3;

/** Lines with their terminators; a last line without one is kept as it is. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function stripEol(line: string): string {
  return line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line;
}

/** cyrb53: a fast 53-bit string hash, the same in the browser and on the server. */
function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

interface Op {
  k: ReviewRowKind;
  line: string;
  /** Index in the base: the line's own, or for an added line the base lines before it. */
  o: number;
  /** Index in the file now, likewise. */
  n: number;
}

/**
 * The blocks between `base` and `current`, or null when the diff would take longer than
 * `timeoutMs` — a large file rewritten wholesale is the one case Myers' diff is slow at, and
 * such a file is answered whole rather than block by block.
 */
export function computeBlocks(
  base: string,
  current: string,
  opts: { context?: number; timeoutMs?: number } = {},
): BlockDiff | null {
  const context = opts.context ?? BLOCK_CONTEXT;
  const parts = diffLines(base, current, { timeout: opts.timeoutMs ?? 200 });
  if (!parts) return null;

  const ops: Op[] = [];
  let o = 0;
  let n = 0;
  let additions = 0;
  let deletions = 0;
  for (const part of parts) {
    const k: ReviewRowKind = part.added ? "+" : part.removed ? "-" : " ";
    for (const line of splitLines(part.value)) {
      ops.push({ k, line, o, n });
      if (k !== "+") o++;
      if (k !== "-") n++;
      if (k === "+") additions++;
      if (k === "-") deletions++;
    }
  }

  const changed: number[] = [];
  ops.forEach((op, i) => { if (op.k !== " ") changed.push(i); });

  const blocks: ReviewBlock[] = [];
  for (let i = 0; i < changed.length;) {
    const first = changed[i]!;
    let last = first;
    let j = i + 1;
    while (j < changed.length && changed[j]! - last - 1 <= 2 * context) last = changed[j++]!;
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length, last + context + 1);
    blocks.push(toBlock(ops.slice(from, to)));
    i = j;
  }
  return { blocks, additions, deletions, oldLines: o, newLines: n };
}

function toBlock(ops: Op[]): ReviewBlock {
  const head = ops[0]!;
  let oldLen = 0;
  let newLen = 0;
  let added = 0;
  let removed = 0;
  const rows: ReviewRow[] = [];
  for (const op of ops) {
    if (op.k !== "+") oldLen++;
    if (op.k !== "-") newLen++;
    if (op.k === "+") added++;
    if (op.k === "-") removed++;
    rows.push({ k: op.k, text: stripEol(op.line), o: op.k === "+" ? null : op.o + 1, n: op.k === "-" ? null : op.n + 1 });
  }
  return {
    key: `${head.o}.${hash53(ops.map((op) => op.k + op.line).join(""))}`,
    oldFrom: head.o,
    oldTo: head.o + oldLen,
    newFrom: head.n,
    newTo: head.n + newLen,
    rows,
    added,
    removed,
  };
}

/** `current` with `blocks` put back to the base's lines; the rest of the file is left as it is. */
export function revertBlocks(base: string, current: string, blocks: ReviewBlock[]): string {
  const old = splitLines(base);
  const now = splitLines(current);
  for (const b of [...blocks].sort((x, y) => y.newFrom - x.newFrom)) {
    now.splice(b.newFrom, b.newTo - b.newFrom, ...old.slice(b.oldFrom, b.oldTo));
  }
  return now.join("");
}

/** The base line a block starts at, read off its key (`<line>.<hash>`). */
export function blockStart(key: string): number {
  const line = Number.parseInt(key, 10);
  return Number.isFinite(line) ? line : 0;
}

/**
 * Where each line of `from` sits in `to` (0-based), or -1 where it is not there unchanged; null
 * when the diff would take longer than `timeoutMs`.
 */
export function lineMap(from: string, to: string, timeoutMs = 200): Int32Array | null {
  const parts = diffLines(from, to, { timeout: timeoutMs });
  if (!parts) return null;
  const at = new Int32Array(splitLines(from).length).fill(-1);
  let o = 0;
  let n = 0;
  for (const part of parts) {
    const count = splitLines(part.value).length;
    if (part.added) n += count;
    else if (part.removed) o += count;
    else for (let i = 0; i < count; i++) at[o++] = n++;
  }
  return at;
}

/**
 * `current` with the change from `from` to `to` made in it, provided every line that change
 * touches, context included, is in `current` exactly as it is in `from`; null otherwise. Undo
 * uses it to put back a reverted block after other blocks of the file were answered since.
 */
export function reapply(from: string, to: string, current: string, timeoutMs = 200): string | null {
  if (current === from) return to;
  const change = computeBlocks(from, to, { timeoutMs });
  const at = lineMap(from, current, timeoutMs);
  if (!change || !at) return null;
  const lines = splitLines(current);
  const target = splitLines(to);
  // Last block first, so the places worked out for the others stay where they are.
  for (const b of [...change.blocks].reverse()) {
    if (b.oldFrom === b.oldTo) {
      // Only an empty `from` has a block with no line of its own to find again.
      if (lines.length) return null;
      lines.push(...target.slice(b.newFrom, b.newTo));
      continue;
    }
    const start = at[b.oldFrom]!;
    for (let i = b.oldFrom; i < b.oldTo; i++) if (start < 0 || at[i] !== start + i - b.oldFrom) return null;
    lines.splice(start, b.oldTo - b.oldFrom, ...target.slice(b.newFrom, b.newTo));
  }
  return lines.join("");
}
