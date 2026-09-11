/**
 * Selection arithmetic for the hunk picker.
 *
 * Kept apart from the component so the mapping from "which lines are ticked" to
 * "what the server is asked to apply" can be tested directly — it is the part
 * that has to be right, since a wrong index stages the wrong line.
 */

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
  noNewline?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading: string;
  lines: DiffLine[];
}

/** `${hunkIndex}:${lineIndex}` — flat, so one Set holds the whole selection. */
export type LineKey = string;

export const lineKey = (hunk: number, line: number): LineKey => `${hunk}:${line}`;

/** Indexes of the changed lines in one hunk. Context is never selectable. */
export function changedLineIndexes(hunk: DiffHunk): number[] {
  const out: number[] = [];
  hunk.lines.forEach((line, i) => {
    if (line.kind !== " ") out.push(i);
  });
  return out;
}

/** Every selectable line across every hunk. */
export function allChangedKeys(hunks: DiffHunk[]): LineKey[] {
  return hunks.flatMap((hunk, h) => changedLineIndexes(hunk).map((i) => lineKey(h, i)));
}

/** How much of one hunk is ticked — drives its checkbox's three states. */
export function hunkState(
  hunks: DiffHunk[],
  index: number,
  selected: Set<LineKey>,
): { picked: number; total: number } {
  const hunk = hunks[index];
  if (!hunk) return { picked: 0, total: 0 };
  const changed = changedLineIndexes(hunk);
  return {
    picked: changed.filter((i) => selected.has(lineKey(index, i))).length,
    total: changed.length,
  };
}

/** Tick a whole hunk, or untick it when it is already fully ticked. */
export function toggleHunk(
  hunks: DiffHunk[],
  index: number,
  selected: Set<LineKey>,
): Set<LineKey> {
  const hunk = hunks[index];
  if (!hunk) return selected;
  const keys = changedLineIndexes(hunk).map((i) => lineKey(index, i));
  const next = new Set(selected);
  const allOn = keys.every((k) => next.has(k));
  for (const key of keys) {
    if (allOn) next.delete(key);
    else next.add(key);
  }
  return next;
}

export function toggleLine(hunk: number, line: number, selected: Set<LineKey>): Set<LineKey> {
  const next = new Set(selected);
  const key = lineKey(hunk, line);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export interface HunkRequest {
  hunk: number;
  /** Line indexes within the hunk; omitted means the whole hunk. */
  lines?: number[];
}

/**
 * The body for `/git/{stage,unstage,discard}-hunks`.
 *
 * A fully ticked hunk is sent without `lines` so the server can take it
 * verbatim; a hunk with nothing ticked is left out entirely rather than sent
 * empty, which the server would reject.
 */
export function buildHunkRequest(hunks: DiffHunk[], selected: Set<LineKey>): HunkRequest[] {
  const out: HunkRequest[] = [];
  hunks.forEach((hunk, h) => {
    const changed = changedLineIndexes(hunk);
    const picked = changed.filter((i) => selected.has(lineKey(h, i)));
    if (picked.length === 0) return;
    out.push(picked.length === changed.length ? { hunk: h } : { hunk: h, lines: picked });
  });
  return out;
}

/**
 * The old/new line number for each row, walked the way git numbers a diff: an
 * addition has no old number and a deletion has no new one.
 */
export function lineNumbers(hunk: DiffHunk): { old: string; next: string }[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line) => ({
    old: line.kind === "+" ? "" : String(oldNo++),
    next: line.kind === "-" ? "" : String(newNo++),
  }));
}
