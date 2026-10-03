import { useLayoutEffect, useState, type RefObject } from "react";

/** Whether the view is at most `width` wide, measured before it is painted; a parked tab keeps its answer. */
export function useAtMostWide(ref: RefObject<HTMLElement | null>, width: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // A tab the pool has parked measures 0 wide: that says nothing about the tab.
      if (el.clientWidth > 0) setNarrow(el.clientWidth <= width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, width]);
  return narrow;
}
