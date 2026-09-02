/**
 * One fixed-width, independently virtualised and independently scrolled column of the
 * Miller browser. Column view keeps a single highlighted entry per column rather than the
 * multi-select semantics List/Icons use — Finder's own column browser works the same way,
 * and it is what lets "the highlighted entry" double as "which directory the next column
 * shows" with no extra state.
 */

import { useContext, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BottomSheetCtx } from "@/components/ui/mobile-bottom-sheet";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import type { ExplorerActions } from "../actions/use-explorer-actions";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { FileTypeIcon } from "../icons/file-type-icon";
import { mobileTapAction } from "../mobile/mobile-tap-action";
import { useCoarseLongPress } from "../use-coarse-long-press";

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

  return (
    <div
      className={cn("flex h-full shrink-0 flex-col", !fullWidth && "border-r border-border", isFocused && "bg-panel-2/40")}
      style={fullWidth ? undefined : { width: COLUMN_WIDTH }}
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto outline-none" role="listbox" aria-label={path}>
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

interface ColumnRowProps {
  entry: FsEntry;
  selected: boolean;
  currentDir: string;
  hasClipboard: boolean;
  isPinned(path: string): boolean;
  actions: ExplorerActions;
  rowHeight: number;
  onSelect(): void;
  onOpen(): void;
}

function ColumnRow({ entry, selected, currentDir, hasClipboard, isPinned, actions, rowHeight, onSelect, onOpen }: ColumnRowProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ColumnRowInteractive entry={entry} selected={selected} rowHeight={rowHeight} onSelect={onSelect} onOpen={onOpen} />
      </ContextMenuTrigger>
      <ExplorerContextMenu
        targets={[entry]}
        currentDir={currentDir}
        hasClipboard={hasClipboard}
        isPinned={isPinned}
        actions={actions}
      />
    </ContextMenu>
  );
}

/**
 * Rendered inside the row's own `<ContextMenu>` — the position `useContext(BottomSheetCtx)`
 * needs to reach this row's own sheet state (see `use-mobile-row-tap.ts` for the same
 * pattern in List/Icons). Column view keeps its existing single-select semantics on mobile —
 * a directory already navigates on tap via `onSelect`; the only mobile addition is opening a
 * viewable file immediately (no double-click on touch) and surfacing the actions sheet for
 * one that has no viewer, instead of a tap that silently does nothing.
 */
function ColumnRowInteractive({
  entry, selected, rowHeight, onSelect, onOpen,
}: Pick<ColumnRowProps, "entry" | "selected" | "rowHeight" | "onSelect" | "onOpen">) {
  const longPress = useCoarseLongPress(onSelect);
  const isMobile = useIsMobile();
  const { setOpen } = useContext(BottomSheetCtx);

  const handleClick = () => {
    onSelect();
    if (!isMobile || entry.type === "directory") return;
    if (mobileTapAction(entry) === "open") onOpen();
    else setOpen(true);
  };

  return (
    <div
      role="option"
      aria-selected={selected}
      data-testid="explorer-column-row"
      data-path={entry.path}
      title={entry.name}
      style={{ height: rowHeight }}
      {...longPress}
      onContextMenu={(e) => {
        // Without this the bubbling contextmenu (real right-click or the synthetic one
        // `useCoarseLongPress` dispatches) reaches the background trigger too and opens
        // both menus at once.
        e.stopPropagation();
        onSelect();
      }}
      onClick={handleClick}
      onDoubleClick={onOpen}
      className={cn(
        "flex w-full items-center gap-1.5 px-2 text-[13px] select-none",
        "can-hover:hover:bg-surface-elevated",
        selected && "bg-accent-wash text-text",
      )}
    >
      <FileTypeIcon name={entry.name} kind={entry.kind} className="size-4 shrink-0" />
      <span className={cn("flex-1 truncate", selected ? "text-text" : "text-text-2")}>{entry.name}</span>
      {entry.type === "directory" && <span className="text-text-subtle">›</span>}
    </div>
  );
}
