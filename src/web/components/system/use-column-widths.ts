import { useCallback, useEffect, useRef, useState } from "react";
import { clampColumnWidth, columnWidthPx, type ColumnWidths, type ResizableColumnKey } from "./process-columns-grid";

/** One entry for the whole app: column widths are a per-device preference, not
 *  per-window state, so they survive reloads and apply to the mobile tab too. */
export const COLUMN_WIDTHS_STORAGE_KEY = "ppm-sysmon-col-widths";

function loadWidths(): ColumnWidths {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ColumnWidths = {};
    for (const k of ["cpu", "ram", "disk", "gpu", "net"] as ResizableColumnKey[]) {
      const v = parsed[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = clampColumnWidth(v);
    }
    return out;
  } catch {
    return {};
  }
}

function saveWidths(widths: ColumnWidths): void {
  try {
    if (Object.keys(widths).length === 0) localStorage.removeItem(COLUMN_WIDTHS_STORAGE_KEY);
    else localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    /* private mode / quota — widths just don't persist */
  }
}

/**
 * Drag-to-resize state for the process table's fixed-width columns.
 *
 * `begin(key, event)` is wired to `pointerdown` on a header's right-edge handle;
 * the drag then follows `pointermove`/`pointerup` on `window`, so the pointer may
 * leave the handle (or the window body) without dropping the drag. Widths persist
 * on release, not on every move. `reset(key)` (double-click) returns one column
 * to its default.
 */
export function useColumnWidths() {
  const [widths, setWidths] = useState<ColumnWidths>(() => (typeof localStorage === "undefined" ? {} : loadWidths()));
  const drag = useRef<{ key: ResizableColumnKey; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const next = clampColumnWidth(d.startWidth + (e.clientX - d.startX));
      setWidths((prev) => (prev[d.key] === next ? prev : { ...prev, [d.key]: next }));
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = "";
      setWidths((prev) => {
        saveWidths(prev);
        return prev;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const begin = useCallback(
    (key: ResizableColumnKey, e: { clientX: number; preventDefault: () => void }) => {
      e.preventDefault(); // no text selection while dragging
      drag.current = { key, startX: e.clientX, startWidth: columnWidthPx(key, widths) };
      document.body.style.cursor = "col-resize";
    },
    [widths],
  );

  const reset = useCallback((key: ResizableColumnKey) => {
    setWidths((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _dropped, ...rest } = prev;
      saveWidths(rest);
      return rest;
    });
  }, []);

  return { widths, begin, reset };
}
