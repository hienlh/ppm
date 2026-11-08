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

/** An attribute selector for one value; only a quote or a backslash needs escaping inside quotes. */
export function attrSelector(attr: string, value: string): string {
  return `[${attr}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

function topOf(el: Element): number {
  return el.getBoundingClientRect().top;
}

/** The first row still visible at the container's top (the one the reader is reading). */
export function firstVisibleRow(container: HTMLElement): RowAnchor | null {
  const top = topOf(container);
  for (const row of container.querySelectorAll<HTMLElement>("[data-msg-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top) return { key: row.dataset.msgId!, offset: rect.top - top };
  }
  return null;
}

/** Scroll so the anchored row is back at its offset; false when it is no longer drawn. */
export function restoreRow(container: HTMLElement, anchor: RowAnchor, attr: "data-msg-id" | "data-turn-start" = "data-msg-id"): boolean {
  const row = container.querySelector<HTMLElement>(attrSelector(attr, anchor.key));
  if (!row) return false;
  const drift = topOf(row) - topOf(container) - anchor.offset;
  if (Math.abs(drift) >= 0.5) container.scrollTop += drift;
  return true;
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
