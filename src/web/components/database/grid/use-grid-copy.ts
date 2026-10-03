/**
 * DBGate's Copy on the grid: the rows the selection lies on by the columns it lies in, written in a
 * format (copy-as.ts). Ctrl+C fills the clipboard from the `copy` event the browser fires at the
 * focused grid, which needs no `navigator.clipboard` — absent on the plain-HTTP origins PPM is often
 * reached over. A menu item copies inside its own click, where the fallback still works. Ctrl+X
 * copies the same way, then clears the cells as Delete does.
 */
import { useCallback, useState, type ClipboardEvent } from "react";
import type { GridSelection } from "@glideapps/glide-data-grid";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";
import { COPY_FORMATS, formatCopy, keepCopyFormat, readCopyFormat, type CopyData, type CopyFormat, type CopySqlTarget } from "./copy-as";
import { selectedBlock } from "./selection-stats";
import { asElement } from "./table-keys";

export interface GridCopySource {
  selection: GridSelection;
  /** The grid's columns in the order it shows them. */
  columns: readonly string[];
  rowCount: number;
  /** A row's every value as the grid shows it now. */
  rowNow: (row: number) => Record<string, unknown>;
  /** A row as the database holds it, which an UPDATE finds it by. */
  rowStored: (row: number) => Record<string, unknown>;
  target: CopySqlTarget;
}

/** Glide's canvas and the scroller over it: the grid itself, not a filter box or the cell editor. */
export function isGridSurface(root: Element, eventTarget: EventTarget | null): boolean {
  const target = asElement(eventTarget);
  return !!target && root.contains(target) && !!target.closest(".dvn-underlay, .dvn-scroller");
}

/** What the selection copies as, or null with nothing selected. */
export function selectionCopyData(source: Omit<GridCopySource, "target">): CopyData | null {
  const block = selectedBlock(source.selection, source.columns.length, source.rowCount);
  if (!block.rows.length || !block.columns.length) return null;
  return {
    columns: block.columns.map((c) => source.columns[c]!),
    rows: block.rows.map(source.rowNow),
    stored: block.rows.map(source.rowStored),
  };
}

/** What a toast says was copied: the value, or how much of what. */
export function copiedMessage(format: CopyFormat, data: CopyData): string {
  const name = COPY_FORMATS.find((f) => f.id === format)!.name;
  if (format === "textWithoutHeaders" && data.rows.length === 1 && data.columns.length === 1) return "Copied the value";
  const rows = `${data.rows.length} row${data.rows.length === 1 ? "" : "s"}`;
  const columns = `${data.columns.length} column${data.columns.length === 1 ? "" : "s"}`;
  return format === "headers" ? `Copied ${columns} · ${name}` : `Copied ${rows} × ${columns} · ${name}`;
}

/**
 * `source` is read whenever something is copied, so it is passed memoised; `clear` (Delete's) runs
 * after a cut only where `canClear`, and `refocus` gives the grid back its keys after a menu item.
 */
export function useGridCopy(source: GridCopySource, canClear: boolean, clear: () => void, refocus: () => void) {
  const [format, setFormatState] = useState<CopyFormat>(readCopyFormat);

  const text = useCallback((as: CopyFormat): { text: string; data: CopyData } | null => {
    const data = selectionCopyData(source);
    return data ? { text: formatCopy(as, data, source.target), data } : null;
  }, [source]);

  /** Copy advanced's items, and Copy itself: in the click, so the fallback copy is allowed to run. */
  const copyAs = useCallback((as: CopyFormat) => {
    const out = text(as);
    if (!out) return;
    void copyToClipboard(out.text).then((ok) => {
      if (ok) toast.success(copiedMessage(as, out.data));
      else toast.error("Could not copy to the clipboard");
    });
    refocus();
  }, [text, refocus]);

  const setFormat = useCallback((as: CopyFormat) => {
    setFormatState(as);
    keepCopyFormat(as);
    toast.info(`Copy format set to ${COPY_FORMATS.find((f) => f.id === as)!.name}`, { description: "Ctrl+C copies in it on this device." });
    refocus();
  }, [refocus]);

  const fill = useCallback((e: ClipboardEvent<HTMLElement>): boolean => {
    if (!isGridSurface(e.currentTarget, e.target)) return false;
    const out = text(format);
    if (!out) return false;
    e.clipboardData.setData("text/plain", out.text);
    e.preventDefault();
    return true;
  }, [text, format]);

  const onCopy = useCallback((e: ClipboardEvent<HTMLElement>) => { fill(e); }, [fill]);
  const onCut = useCallback((e: ClipboardEvent<HTMLElement>) => {
    if (fill(e) && canClear) clear();
  }, [fill, canClear, clear]);

  return { format, setFormat, copyAs, onCopy, onCut };
}
