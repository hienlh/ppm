/**
 * Element-relative scroll anchoring for the chat's scrollers.
 *
 * The scrollers set `overflow-anchor: none`, so the browser keeps nothing in place when rows are
 * inserted above the viewport. Keeping the reader's place across such a change means recording a
 * row that is on screen and its distance from the container's top before the change, and scrolling
 * by however far that row moved once the change is laid out.
 */

export interface RowAnchor {
  /** The row's `data-msg-id`, or its turn id when it is a turn start found by `turnStartAt`. */
  key: string;
  /** Distance from the container's top to the row's top, in px; negative when above it. */
  offset: number;
}

/**
 * The reader's place, kept so it survives rows being replaced as well as moved: a row's id changes
 * when a streamed answer is finalised (`streaming-…` becomes `final-…`) and when history is read
 * again (every row the browser made becomes the server's), so the rows around the first visible
 * one are kept too, and the reader's own message above it by what it says.
 */
export interface ReadingAnchor {
  /**
   * The first visible row, then the rows just above it, nearest first. A user message among them
   * carries its `data-anchor-key` (its text, hashed) as `userKey`: when its id is gone, the same
   * message drawn under another id is tried before any row above it.
   */
  rows: Array<RowAnchor & { userKey?: string }>;
}

/** An attribute selector for one value; only a quote or a backslash needs escaping inside quotes. */
export function attrSelector(attr: string, value: string): string {
  return `[${attr}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

function topOf(el: Element): number {
  return el.getBoundingClientRect().top;
}

/** Index of the first row whose bottom is below `top`: rows are in document order, so a binary search. */
function firstBelow(rows: ArrayLike<HTMLElement>, top: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The first row still visible at the container's top (the one the reader is reading). */
export function firstVisibleRow(container: HTMLElement): RowAnchor | null {
  const top = topOf(container);
  const rows = container.querySelectorAll<HTMLElement>("[data-msg-id]");
  const i = firstBelow(rows, top);
  const row = rows[i];
  return row ? { key: row.dataset.msgId!, offset: row.getBoundingClientRect().top - top } : null;
}

/** How many rows above the first visible one are kept as fallbacks. */
const FALLBACK_ROWS = 4;
/** How far up a user message is looked for: a long answer is many rows in history. */
const MAX_ROWS = 40;
/** Rows on screen below the first visible one that are kept as fallbacks too. */
const BELOW_ROWS = 3;

/** The reader's place: the first visible row, the rows above it, and their own message above it. */
export function readingAnchorAt(container: HTMLElement): ReadingAnchor | null {
  const top = topOf(container);
  const rows = container.querySelectorAll<HTMLElement>("[data-msg-id]");
  const first = firstBelow(rows, top);
  if (first >= rows.length) return null;
  const kept: ReadingAnchor["rows"] = [];
  const take = (row: HTMLElement) => {
    const userKey = row.dataset.anchorKey;
    kept.push({ key: row.dataset.msgId!, offset: row.getBoundingClientRect().top - top, ...(userKey ? { userKey } : {}) });
    return !!userKey;
  };
  let sawUser = false;
  // Rows up to the nearest user message at or above the top, and a few more above it.
  for (let i = first; i >= 0 && (kept.length <= FALLBACK_ROWS || (!sawUser && kept.length < MAX_ROWS)); i--) {
    if (take(rows[i]!)) sawUser = true;
  }
  // And the rows on screen below it, last: the message just sent is often one of them, but a row
  // below the reader also moves when something between (a card the reader opens) changes height.
  const bottom = top + container.clientHeight;
  for (let i = first + 1; i < rows.length && i <= first + BELOW_ROWS && rows[i]!.getBoundingClientRect().top < bottom; i++) take(rows[i]!);
  return { rows: kept };
}

/** Scroll so the anchored row is back at its offset; false when it is no longer drawn. */
export function restoreRow(container: HTMLElement, anchor: RowAnchor, attr: "data-msg-id" | "data-turn-start" | "data-anchor-key" = "data-msg-id"): boolean {
  const all = container.querySelectorAll<HTMLElement>(attrSelector(attr, anchor.key));
  // The same text can be sent twice; the reader is nearer the end of the list.
  const row = all[all.length - 1];
  if (!row) return false;
  const drift = topOf(row) - topOf(container) - anchor.offset;
  // Under a pixel is rounding; writing it anyway is a scroll a bottom follower reads as the reader's.
  if (Math.abs(drift) >= 1) container.scrollTop += drift;
  return true;
}

/**
 * Puts the reader's place back: the nearest of its rows still drawn, and for the reader's own
 * message, the same message under its new id before any row further up.
 */
export function restoreReadingAnchor(container: HTMLElement, anchor: ReadingAnchor): boolean {
  const [first, ...rest] = anchor.rows;
  if (!first) return false;
  // The row being read, while it is still drawn under its id: nothing else says the place as well.
  if (restoreRow(container, first)) return true;
  // Gone (finalised, or history read again): the nearest of the others to the top, by id and then,
  // for a user message, by what it says.
  const byUser = (row: ReadingAnchor["rows"][number]) => !!row.userKey && restoreRow(container, { key: row.userKey, offset: row.offset }, "data-anchor-key");
  for (const row of [...rest].sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))) {
    if (restoreRow(container, row) || byUser(row)) return true;
  }
  return byUser(first);
}

/**
 * A key for a user message that does not change when its row does: the browser's bubble and the
 * history's record of the same message carry different ids but the same text. FNV-1a, base 36.
 */
export function userAnchorKey(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `u${h.toString(36)}-${content.length}`;
}

/**
 * The turn the reader is in at the container's top: the last turn start at or above it, or the
 * first one below it when the top is above every turn start.
 */
export function turnStartAt(container: HTMLElement): RowAnchor | null {
  const top = topOf(container);
  let found: RowAnchor | null = null;
  for (const row of container.querySelectorAll<HTMLElement>("[data-turn-start]")) {
    const offset = topOf(row) - top;
    if (offset > 1 && found) break;
    found = { key: row.dataset.turnStart!, offset };
    if (offset > 1) break;
  }
  return found;
}
