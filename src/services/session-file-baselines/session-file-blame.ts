/**
 * Which calls wrote each block of a file's review — what puts a turn on a block.
 *
 * The file's history (`session-file-history.ts`) is replayed from the state the blocks were cut
 * against, the way `git blame` walks commits: every line carries the call that put it in, and
 * every line of that state the call that took it out. A change between one call's "after" and
 * the next call's "before" was made by no call (the user, a formatter, another program) and
 * names none, and neither does anything the history does not cover — a session from before it
 * was kept, or a state that was not text.
 *
 * Replays are kept, per file and per base, and only the lines a log gained since are read, so
 * asking again after every edit costs that edit's diff and nothing more.
 */
import { diffLines } from "diff";
import { statSync } from "node:fs";
import { splitLines, type ReviewBlock } from "../../shared/review-blocks.ts";
import { HISTORY_START, historyFile, readHistory, stateHash, type HistoryEntry, type HistoryPosition } from "./session-file-history.ts";

/** Label 0 is "no call": a line of the base, or one changed by nobody the history names. */
const NOBODY = 0;

interface Replay {
  /** Line ids of the base, in order. */
  base: number[];
  /** Line ids of the state reached, in order. */
  lines: number[];
  /** By line id: the label of the call that put the line in, and of the one that took it out. */
  addedBy: number[];
  removedBy: number[];
  /** By label: the call it names. */
  calls: string[];
  callLabels: Map<string, number>;
  /** The last state read and the log position after it. */
  pos: HistoryPosition;
  /** The last text known, which `pos.text` is not when the chain broke. */
  text: string;
  /** The call whose "before" was the last observation, while its "after" is still to come. */
  open: string | null;
  /** A state that was not text came between the last text and the next one. */
  broken: boolean;
  /** No history reached the base yet: observations before the mark are skipped. */
  waiting: boolean;
}

const replays = new Map<string, Replay>();
const REPLAYS_KEPT = 256;

function labelOf(r: Replay, call: string): number {
  let label = r.callLabels.get(call);
  if (label === undefined) {
    label = r.calls.length;
    r.calls.push(call);
    r.callLabels.set(call, label);
  }
  return label;
}

function freshLine(r: Replay, label: number): number {
  r.addedBy.push(label);
  r.removedBy.push(NOBODY);
  return r.addedBy.length - 1;
}

/** Move from the text reached to `next`, the lines that differ put in or taken out by `label`. */
function advance(r: Replay, next: string, label: number): void {
  if (next === r.text) return;
  const parts = diffLines(r.text, next, { timeout: 200 });
  const lines: number[] = [];
  if (!parts) {
    // Too slow to diff: the whole file is taken as rewritten.
    for (const id of r.lines) if (!r.removedBy[id]) r.removedBy[id] = label;
    for (let i = 0; i < splitLines(next).length; i++) lines.push(freshLine(r, label));
  } else {
    let i = 0;
    for (const part of parts) {
      const n = splitLines(part.value).length;
      if (part.added) for (let k = 0; k < n; k++) lines.push(freshLine(r, label));
      else if (part.removed) {
        for (let k = 0; k < n; k++) {
          const id = r.lines[i++]!;
          if (!r.removedBy[id]) r.removedBy[id] = label;
        }
      } else for (let k = 0; k < n; k++) lines.push(r.lines[i++]!);
    }
  }
  r.lines = lines;
  r.text = next;
}

function step(r: Replay, e: HistoryEntry, markedAt: number | undefined): void {
  if (r.waiting) {
    // Against a review mark the base is the state that was marked: what the history says
    // before that moment is already in it.
    if (e.at <= markedAt!) {
      r.open = e.phase === "before" ? e.call : null;
      return;
    }
    r.waiting = false;
  }
  if (e.text === null) {
    r.broken = true;
  } else {
    const own = e.phase === "after" && r.open === e.call && !r.broken;
    advance(r, e.text, own ? labelOf(r, e.call) : NOBODY);
    r.broken = false;
  }
  r.open = e.phase === "before" ? e.call : null;
}

function start(baseText: string, markedAt: number | undefined): Replay {
  const base = splitLines(baseText).map((_, i) => i);
  return {
    base,
    lines: [...base],
    addedBy: base.map(() => NOBODY),
    removedBy: base.map(() => NOBODY),
    calls: [""],
    callLabels: new Map(),
    pos: HISTORY_START,
    text: baseText,
    open: null,
    broken: false,
    waiting: markedAt !== undefined,
  };
}

/** The replay of `path` from `baseText` up to the end of its log, reusing what was read before. */
function replayed(sessionId: string, path: string, baseText: string, markedAt: number | undefined): Replay | null {
  const file = historyFile(sessionId, path);
  if (!file) return null;
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  const key = `${sessionId}\0${path}\0${stateHash(baseText)}\0${markedAt ?? ""}`;
  let r = replays.get(key);
  // A log shorter than what was read is one written again, after its session was deleted.
  if (!r || size < r.pos.bytes) r = start(baseText, markedAt);
  if (size > r.pos.bytes) {
    const { entries, end } = readHistory(sessionId, path, r.pos);
    for (const e of entries) step(r, e, markedAt);
    r.pos = end;
  }
  replays.delete(key);
  replays.set(key, r);
  if (replays.size > REPLAYS_KEPT) replays.delete(replays.keys().next().value!);
  return r;
}

/**
 * The calls that wrote each of `blocks`, cut from `baseText` to `currentText`, in the order
 * they ran; an empty list where the history names none. `markedAt` is set when the base is the
 * state the file was marked reviewed in rather than its "before".
 */
export function blockCalls(p: {
  sessionId: string;
  path: string;
  baseText: string;
  currentText: string;
  blocks: ReviewBlock[];
  markedAt?: number;
}): string[][] | null {
  const r = replayed(p.sessionId, p.path, p.baseText, p.markedAt);
  if (!r) return null;
  // What changed since the last observation was changed by nobody the history names.
  let current = r.lines;
  if (p.currentText !== r.text) {
    const parts = diffLines(r.text, p.currentText, { timeout: 200 });
    current = [];
    if (parts) {
      let i = 0;
      for (const part of parts) {
        const n = splitLines(part.value).length;
        if (part.added) for (let k = 0; k < n; k++) current.push(-1);
        else if (part.removed) i += n;
        else for (let k = 0; k < n; k++) current.push(r.lines[i++]!);
      }
    }
  }
  return p.blocks.map((b) => {
    const labels = new Set<number>();
    for (const row of b.rows) {
      if (row.k === "+" && row.n !== null) {
        const id = current[row.n - 1];
        if (id !== undefined && id >= 0 && r.addedBy[id]) labels.add(r.addedBy[id]!);
      } else if (row.k === "-" && row.o !== null) {
        const id = r.base[row.o - 1];
        if (id !== undefined && r.removedBy[id]) labels.add(r.removedBy[id]!);
      }
    }
    return [...labels].sort((x, y) => x - y).map((l) => r.calls[l]!);
  });
}

/** Test seam: forget every kept replay. */
export function _resetSessionFileBlame(): void {
  replays.clear();
}
