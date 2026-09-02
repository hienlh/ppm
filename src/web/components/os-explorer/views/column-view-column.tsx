/**
 * One fixed-width, independently virtualised and independently scrolled column of the
 * Miller browser. Column view keeps a single highlighted entry per column rather than the
 * multi-select semantics List/Icons use — Finder's own column browser works the same way,
 * and it is what lets "the highlighted entry" double as "which directory the next column
 * shows" with no extra state.
 */

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import type { ExplorerActions } from "../actions/use-explorer-actions";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { FileTypeIcon } from "../icons/file-type-icon";
import { useCoarseLongPress } from "../use-coarse-long-press";

export const COLUMN_WIDTH = 220;

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
}

export function ColumnViewColumn({
  path, entries, loading, error, selectedPath, isFocused, currentDir,
  hasClipboard, isPinned, actions, rowHeight, onSelect, onOpen, onFocus,
}: ColumnViewColumnProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });

  return (
    <div
      className={cn("flex h-full shrink-0 flex-col border-r border-border", isFocused && "bg-panel-2/40")}
      style={{ width: COLUMN_WIDTH }}
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
                  rowHeight={rowHeight}
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
  const longPress = useCoarseLongPress(onSelect);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
          onClick={onSelect}
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
