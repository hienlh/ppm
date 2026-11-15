/**
 * Scrolling a chat's message list so one element in it can be read, without touching anything
 * else. `scrollIntoView` would also move every ancestor that can be scrolled from script,
 * `overflow: hidden` ones included (a floating window's frame, the app's panels), and leave the
 * layout shifted, so only the nearest list that scrolls is moved.
 *
 * The list's last pixels are not readable: the chat footer sits over them and they fade out
 * (`.chat-scroll-fade`). `BOTTOM_GAP` keeps an element's end clear of that, and of the message
 * navigator floating in the list's bottom-right corner (`[data-chat-scroll-nav]`), which would
 * otherwise sit on a card's right-most button (OK, on a phone).
 */

/** Space left above an element brought to the list's top, in px. */
export const TOP_GAP = 12;
/** Space kept under an element's end: the faded strip the chat footer covers, plus a margin. */
export const BOTTOM_GAP = 24;

/** The nearest ancestor of `el` that scrolls vertically, below `stop`. */
export function scrollParent(el: HTMLElement, stop?: HTMLElement | null): HTMLElement | null {
  for (let node = el.parentElement; node && node !== stop; node = node.parentElement) {
    const y = getComputedStyle(node).overflowY;
    if (y === "auto" || y === "scroll") return node;
  }
  return null;
}

/**
 * Where to scroll `list` so `el` can be read. `land`: brought to the top when it fits whole
 * (all of it then shows, flush with the top when the gap above would not leave room); when it is
 * taller than the list, its end (a card's buttons) is put just above the footer. `reveal`: moved
 * as little as possible to show its end, but never so far that its top leaves the list. Answers the new `scrollTop`, or null when nothing has to move.
 */
export function revealTarget(
  el: { top: number; height: number },
  list: { top: number; height: number; scrollTop: number },
  mode: "land" | "reveal",
  bottomGap = BOTTOM_GAP,
): number | null {
  const top = el.top - list.top;
  const room = list.height - TOP_GAP - bottomGap;
  const toTop = list.scrollTop + top - TOP_GAP;
  const toEnd = list.scrollTop + top + el.height - (list.height - bottomGap);
  if (mode === "land") {
    if (el.height <= room) return Math.max(0, toTop);
    // Fits only without the gap above it: flush with the list's top, so still all of it shows.
    if (el.height <= list.height - bottomGap) return Math.max(0, list.scrollTop + top);
    return Math.max(0, toEnd);
  }
  if (top + el.height <= list.height - bottomGap && top >= 0) return null;
  return Math.max(0, Math.min(toEnd, toTop));
}

/** The space to keep under an element's end in `list`: the faded strip, or the navigator above it. */
function bottomGapOf(list: HTMLElement): number {
  const nav = (list.closest("[data-chat-list]") ?? list.parentElement)?.querySelector<HTMLElement>("[data-chat-scroll-nav]");
  const r = nav?.getBoundingClientRect();
  if (!r || r.height === 0) return BOTTOM_GAP;
  return Math.max(BOTTOM_GAP, Math.round(list.getBoundingClientRect().bottom - r.top) + 8);
}

/** Scrolls the list holding `el` so it can be read (see `revealTarget`). Answers that list. */
export function revealInScrollList(el: HTMLElement, mode: "land" | "reveal", opts: { stop?: HTMLElement | null; smooth?: boolean } = {}): HTMLElement | null {
  const list = scrollParent(el, opts.stop);
  if (!list) return null;
  const r = el.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  const to = revealTarget({ top: r.top, height: r.height }, { top: l.top, height: list.clientHeight, scrollTop: list.scrollTop }, mode, bottomGapOf(list));
  if (to !== null) list.scrollTo({ top: to, behavior: opts.smooth ? "smooth" : "auto" });
  return list;
}
