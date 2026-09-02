/**
 * Column view's mobile presentation: only the focused column ever renders, full width, with
 * a Back row above it instead of the desktop's side-by-side Miller strip — there is no room
 * for more than one column on a phone, and no preview pane (files open directly on tap, see
 * `column-view-column.tsx`'s mobile branch).
 */

import type { KeyboardEvent, RefObject } from "react";
import { ArrowLeft } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { FsEntry } from "@/lib/fs-api";
import type { ExplorerActions } from "../actions/use-explorer-actions";
import { ExplorerContextMenu } from "../explorer-context-menu";
import type { ExplorerSlice } from "../explorer-store";
import type { LongPressHandlers } from "../use-coarse-long-press";
import { ColumnViewColumn } from "./column-view-column";
import type { ColumnState } from "./use-column-view-state";

export interface ColumnViewMobileProps {
  containerRef: RefObject<HTMLDivElement | null>;
  onKeyDown(event: KeyboardEvent): void;
  backgroundLongPress: LongPressHandlers;
  columns: ColumnState[];
  focusedIndex: number;
  setFocusedIndex(update: (i: number) => number): void;
  selectedPathFor(index: number): string | null;
  slice: ExplorerSlice;
  hasClipboard: boolean;
  isPinned(path: string): boolean;
  actions: ExplorerActions;
  onSelect(index: number, entry: FsEntry): void;
  onOpen(entry: FsEntry): void;
}

export function ColumnViewMobile({
  containerRef, onKeyDown, backgroundLongPress, columns, focusedIndex, setFocusedIndex,
  selectedPathFor, slice, hasClipboard, isPinned, actions, onSelect, onOpen,
}: ColumnViewMobileProps) {
  const current = columns[focusedIndex];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          tabIndex={0}
          data-testid="explorer-columns"
          aria-label="Column view"
          onKeyDown={onKeyDown}
          className="flex h-full min-h-0 w-full flex-col outline-none"
          {...backgroundLongPress}
        >
          {focusedIndex > 0 && (
            <button
              type="button"
              onClick={() => setFocusedIndex((i) => i - 1)}
              aria-label="Back"
              className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3 text-sm text-text-2 active:bg-surface-elevated"
            >
              <ArrowLeft className="size-4" /> Back
            </button>
          )}
          {current && (
            <div
              key={current.path}
              className="min-h-0 flex-1 motion-safe:animate-in motion-safe:slide-in-from-right-4 motion-safe:duration-150"
            >
              <ColumnViewColumn
                path={current.path}
                entries={current.entries}
                loading={current.loading}
                error={current.error}
                selectedPath={selectedPathFor(focusedIndex)}
                isFocused
                fullWidth
                currentDir={slice.path}
                hasClipboard={hasClipboard}
                isPinned={isPinned}
                actions={actions}
                onSelect={(entry) => onSelect(focusedIndex, entry)}
                onOpen={onOpen}
                onFocus={() => {}}
              />
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ExplorerContextMenu
        targets={[]}
        currentDir={slice.path}
        hasClipboard={hasClipboard}
        isPinned={isPinned}
        actions={actions}
      />
    </ContextMenu>
  );
}
