/**
 * Which lines of the editor's buffer differ from the file in git's index, in
 * the three kinds VS Code's gutter draws: lines added, lines modified, and
 * lines deleted (a marker between the lines that were either side of them).
 *
 * Pure, and kept out of the hook so it runs under `bun:test` without Monaco.
 *
 * Runs on the main thread on every pause in typing, so it is built to be cheap
 * where typing is: the lines both sides share at the start and at the end are
 * stepped over first, which leaves an ordinary edit with a middle of a few
 * lines for the real diff. Only a middle the diff cannot finish within the
 * budget (a file rewritten from top to bottom) is reported coarsely, as one
 * modified range covering it — never as lines it did not check.
 */
import { diffArrays } from "diff";

export type GutterChangeKind = "added" | "modified" | "deleted";

export interface GutterChange {
  kind: GutterChangeKind;
  /**
   * 1-based lines of the buffer, inclusive. For `deleted` both are the line
   * the removed lines followed, and 0 means they were above the first line.
   */
  startLine: number;
  endLine: number;
}

/**
 * The index's text as Monaco would split it: on `\r\n`, `\r` or `\n`, with no
 * byte-order mark (Monaco keeps a BOM out of the model, so line 1 would
 * otherwise always differ), and a final newline leaving an empty last line.
 */
export function splitBaseLines(text: string): string[] {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
}

/** Milliseconds the diff gets before the middle is reported whole. */
const DEFAULT_TIMEOUT_MS = 50;

export function computeGutterChanges(
  base: readonly string[],
  current: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): GutterChange[] {
  const shorter = Math.min(base.length, current.length);
  let head = 0;
  while (head < shorter && base[head] === current[head]) head++;
  let tail = 0;
  while (tail < shorter - head && base[base.length - 1 - tail] === current[current.length - 1 - tail]) tail++;

  const removed = base.length - head - tail;
  const added = current.length - head - tail;
  if (removed === 0 && added === 0) return [];
  if (removed === 0) return [{ kind: "added", startLine: head + 1, endLine: head + added }];
  if (added === 0) return [{ kind: "deleted", startLine: head, endLine: head }];

  const parts = diffArrays(
    base.slice(head, base.length - tail),
    current.slice(head, current.length - tail),
    { timeout: timeoutMs },
  );
  if (!parts) return [{ kind: "modified", startLine: head + 1, endLine: head + added }];

  const changes: GutterChange[] = [];
  // Lines of the buffer passed so far, i.e. the 1-based line a change ends on.
  let line = head;
  let pendingRemoved = 0;
  let pendingAdded = 0;
  const flush = () => {
    if (pendingAdded > 0) {
      const kind = pendingRemoved > 0 ? "modified" : "added";
      changes.push({ kind, startLine: line - pendingAdded + 1, endLine: line });
    } else if (pendingRemoved > 0) {
      changes.push({ kind: "deleted", startLine: line, endLine: line });
    }
    pendingRemoved = 0;
    pendingAdded = 0;
  };
  for (const part of parts) {
    const count = part.count ?? part.value.length;
    if (part.added) {
      pendingAdded += count;
      line += count;
    } else if (part.removed) {
      pendingRemoved += count;
    } else {
      flush();
      line += count;
    }
  }
  flush();
  return changes;
}
