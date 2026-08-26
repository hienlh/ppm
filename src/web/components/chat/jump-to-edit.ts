/**
 * Scroll the transcript to a specific edit and flash it — the change tray's primary
 * action.
 *
 * Deliberately not `scrollIntoView`: that ignores the desired offset and picks its own
 * scroll container. Offsets are computed against the real container instead, matching
 * chat-scroll-nav's approach.
 *
 * Sub-agent tool cards render inside their own `overflow-y-auto` box, so an edit can be
 * scrolled out of view *within* that box while the transcript is already in position.
 * Nested scrollers are therefore aligned innermost-first before the transcript moves.
 */

const JUMP_OFFSET_PX = 60;
const NESTED_OFFSET_PX = 8;
const FLASH_MS = 1400;

export type AnchorLevel = "edit" | "card";

function isScrollable(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight) return false;
  const overflowY = getComputedStyle(el).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

/** Scrollable elements between `target` and `container`, innermost first. */
function scrollableAncestors(target: HTMLElement, container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  let el = target.parentElement;
  while (el && el !== container) {
    if (isScrollable(el)) out.push(el);
    el = el.parentElement;
  }
  return out;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Resolve an edit ref to its element. Falls back to the tool card when the card is
 * collapsed, since the per-edit wrapper is then unmounted.
 */
export function resolveAnchor(
  container: HTMLElement,
  editRef: string,
): { el: HTMLElement; level: AnchorLevel } | null {
  const edit = container.querySelector<HTMLElement>(`[data-edit-ref="${CSS.escape(editRef)}"]`);
  if (edit) return { el: edit, level: "edit" };

  const toolUseId = editRef.replace(/-\d+$/, "");
  const card = container.querySelector<HTMLElement>(`[data-tool-ref="${CSS.escape(toolUseId)}"]`);
  return card ? { el: card, level: "card" } : null;
}

/** Scroll `container` so `target` sits `offset` px below the top of `scroller`. */
function alignWithin(scroller: HTMLElement, target: HTMLElement, offset: number, smooth: boolean): void {
  const top = scroller.scrollTop + target.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top - offset;
  scroller.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
}

/**
 * Scroll to `editRef` and flash it. Returns a cleanup that cancels the pending flash
 * clear — call it on unmount, and keep it so a re-jump to the same element does not
 * leave a stale timer behind.
 */
export function jumpToEdit(container: HTMLElement, editRef: string): () => void {
  const found = resolveAnchor(container, editRef);
  if (!found) return () => {};
  const { el, level } = found;

  // Nested scrollers move instantly; animating them alongside the transcript is janky.
  for (const scroller of scrollableAncestors(el, container)) {
    alignWithin(scroller, el, NESTED_OFFSET_PX, false);
  }
  alignWithin(container, el, JUMP_OFFSET_PX, !prefersReducedMotion());

  el.dataset.flash = level;
  const timer = setTimeout(() => {
    delete el.dataset.flash;
  }, FLASH_MS);

  return () => {
    clearTimeout(timer);
    delete el.dataset.flash;
  };
}
