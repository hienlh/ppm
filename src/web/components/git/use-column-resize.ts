import { useState, useRef } from "react";

/** Generic column resize hook — uses refs to avoid stale closures */
export function useColumnResize(initialWidths: Record<string, number>) {
  const [widths, setWidths] = useState(initialWidths);
  const widthsRef = useRef(initialWidths);
  widthsRef.current = widths;
  const dragging = useRef(false);

  const startResize = (colKey: string, startX: number) => {
    dragging.current = true;
    const startW = widthsRef.current[colKey] ?? 80;
    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!dragging.current) return;
      const clientX = "touches" in ev ? ev.touches[0]!.clientX : ev.clientX;
      const newW = Math.max(40, startW + clientX - startX);
      setWidths((prev) => ({ ...prev, [colKey]: newW }));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
  };

  return { widths, startResize };
}
