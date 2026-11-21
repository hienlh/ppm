/**
 * Marks which ends of a horizontal scroller still hide content, so CSS can fade those edges.
 *
 * It writes `data-fade-start` / `data-fade-end` on the element itself rather than going through
 * React state: a scroll fires on every frame, and re-rendering the chat footer for each one would
 * cost far more than flipping two attributes.
 *
 * The scroller's own size is not enough to watch. Its content changes width without it resizing —
 * a chip appears, a count grows a digit, a container query drops a chip's words — so every child
 * is observed too, and the child list is re-read whenever it changes.
 */
import { useEffect, useState } from "react";

/** Below a pixel is rounding (fractional widths, zoom), not hidden content. */
const SLACK_PX = 1;

/** Which ends of a scroller have content beyond them. */
export function scrollEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): { start: boolean; end: boolean } {
  if (scrollWidth - clientWidth <= SLACK_PX) return { start: false, end: false };
  return {
    start: scrollLeft > SLACK_PX,
    end: scrollLeft + clientWidth < scrollWidth - SLACK_PX,
  };
}

function toggle(el: HTMLElement, name: string, on: boolean) {
  if (on) el.setAttribute(name, "");
  else el.removeAttribute(name);
}

/**
 * Returns the ref to put on the scroller. A callback ref, so an element that mounts later (or is
 * replaced) is picked up rather than missed by an effect that already ran.
 */
export function useScrollEdgeFades(): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? window;
    let frame = 0;
    const update = () => {
      frame = 0;
      const { start, end } = scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
      toggle(el, "data-fade-start", start);
      toggle(el, "data-fade-end", end);
    };
    const schedule = () => { if (!frame) frame = win.requestAnimationFrame(update); };

    // The window the scroller lives in: a picture-in-picture window has its own ResizeObserver.
    const RO = (win as typeof window).ResizeObserver ?? ResizeObserver;
    const resize = new RO(schedule);
    const observeChildren = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of Array.from(el.children)) resize.observe(child);
    };
    const MO = (win as typeof window).MutationObserver ?? MutationObserver;
    const mutations = new MO(() => { observeChildren(); schedule(); });

    observeChildren();
    mutations.observe(el, { childList: true });
    el.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      el.removeEventListener("scroll", schedule);
      mutations.disconnect();
      resize.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
    };
  }, [el]);
  return setEl;
}
