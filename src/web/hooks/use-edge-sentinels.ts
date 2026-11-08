/**
 * Sentinels at both ends of a scroll container: the top one asks for the page before as it comes
 * within 400 px of the viewport, the bottom one reports whether the end is in range.
 *
 * The observer is rebuilt whenever `rebuildKey` changes (what may be asked for has changed): an
 * IntersectionObserver reports changes only, so a sentinel still in range after a page landed
 * would otherwise never ask again. A hidden tab (TabPool parks it with `display: none`) has no
 * height and every sentinel reads as in range there; what the observer says then is set aside and
 * asked again once the container has a height.
 */
import { useEffect, useState, type RefObject } from "react";

export function useEdgeSentinels(
  scrollEl: HTMLElement | null,
  top: RefObject<HTMLElement | null>,
  bottom: RefObject<HTMLElement | null>,
  onTopInRange: () => void,
  rebuildKey: string,
): boolean {
  const [bottomInView, setBottomInView] = useState(false);
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    const sentinels = [top.current, bottom.current].filter((s): s is HTMLElement => !!s);
    let parked = false;
    const io = new IntersectionObserver((entries) => {
      parked = el.clientHeight === 0;
      if (parked) return;
      for (const e of entries) {
        if (e.target === top.current && e.isIntersecting) onTopInRange();
        if (e.target === bottom.current) setBottomInView(e.isIntersecting);
      }
    }, { root: el, rootMargin: "400px 0px 400px 0px" });
    for (const s of sentinels) io.observe(s);
    const ro = new ResizeObserver(() => {
      if (!parked || el.clientHeight === 0) return;
      parked = false;
      for (const s of sentinels) {
        io.unobserve(s);
        io.observe(s);
      }
    });
    ro.observe(el);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, [scrollEl, top, bottom, onTopInRange, rebuildKey]);
  return bottomInView;
}
