/**
 * One fixed-width, independently virtualised and independently scrolled column of the
 * Miller browser. Column view keeps a single highlighted entry per column rather than the
 * multi-select semantics List/Icons use — Finder's own column browser works the same way,
 * and it is what lets "the highlighted entry" double as "which directory the next column
 * shows" with no extra state.
 */

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import type { ExplorerActions } from "../actions/use-explorer-actions";
import { DROP_TARGET_CLASS } from "../dnd/drop-target-style";
import { usePathDropTarget } from "../dnd/use-path-drop-target";
import { ColumnRow } from "./column-row";

export const COLUMN_WIDTH = 220;
/** Mobile's single full-width column needs a 44px+ touch target, bigger than the desktop
 *  (fine/coarse-pointer) `rowHeight` threaded in from `ExplorerBody`. Exported so
 *  `column-view-mobile.tsx` can pass a real value instead of a duplicated magic number —
 *  the `fullWidth` branch here always wins over whatever `rowHeight` prop it receives. */
export const ROW_HEIGHT_MOBILE = 48;

export interface ColumnViewColumnProps {
  path: string;
  entries: FsEntry[];
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  isFocused: boolean;
  currentDir: string;
  hasClipboard: boolean;
  isPinned(path: string): boolean;
  actions: ExplorerActions;
  /** Row height in px; larger on coarse-pointer devices, same as List/Icons. */
  rowHeight: number;
  onSelect(entry: FsEntry): void;
  onOpen(entry: FsEntry): void;
  onFocus(): void;
  /** Mobile's single-column mode: fill the container instead of the fixed desktop width. */
  fullWidth?: boolean;
}

export function ColumnViewColumn({
  path, entries, loading, error, selectedPath, isFocused, currentDir,
  hasClipboard, isPinned, actions, rowHeight, onSelect, onOpen, onFocus, fullWidth,
}: ColumnViewColumnProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Mobile's single full-width column always wants the bigger touch target, regardless of
  // whatever fine/coarse-pointer density the caller threaded in for the desktop Miller strip.
  const effectiveRowHeight = fullWidth ? ROW_HEIGHT_MOBILE : rowHeight;
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => effectiveRowHeight,
    overscan: 8,
  });
  // The column's own empty area is a drop target for its own directory — dropping below the
  // last row of an ancestor column moves/copies into that ancestor, not just the deepest one.
  // Mobile's single full-width column never gets one: no drag source can ever start on touch.
  const backgroundDrop = usePathDropTarget({ targetDir: path, run: actions.transferInto, disabled: fullWidth });

  return (
    <div
      className={cn("flex h-full shrink-0 flex-col", !fullWidth && "border-r border-border", isFocused && "bg-panel-2/40")}
      style={fullWidth ? undefined : { width: COLUMN_WIDTH }}
    >
      <div
        ref={scrollRef}
        role="listbox"
        aria-label={path}
        className={cn("flex-1 overflow-y-auto outline-none", backgroundDrop.isOver && DROP_TARGET_CLASS)}
        {...backgroundDrop.handlers}
      >
        {loading && entries.length === 0 && <p className="p-2 text-xs text-text-subtle">Loading…</p>}
        {error && <p className="p-2 text-xs text-error">{error}</p>}
        {!loading && !error && entries.length === 0 && <p className="p-2 text-xs text-text-subtle">Empty</p>}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index]!;
            const selected = entry.path === selectedPath;
            return (
              <div
                key={entry.path}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <ColumnRow
                  entry={entry}
                  selected={selected}
                  currentDir={currentDir}
                  hasClipboard={hasClipboard}
                  isPinned={isPinned}
                  actions={actions}
                  rowHeight={effectiveRowHeight}
                  onSelect={() => {
                    onFocus();
                    onSelect(entry);
                  }}
                  onOpen={() => onOpen(entry)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
