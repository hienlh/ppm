import { useEffect, useState, type RefObject } from "react";

/**
 * Live `clientWidth` of an element, tracked through `ResizeObserver`.
 *
 * Canvas charts cannot size themselves with CSS alone — the bitmap needs a pixel
 * width — so a chart inside a resizable card or floating window has to be told how
 * wide its box currently is. Returns 0 until the first measurement.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? el.clientWidth);
      setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
