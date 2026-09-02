/**
 * Icons view: a responsive tile grid, virtualised by row so a folder of thousands of
 * images never puts more than a couple of rows' worth of thumbnails in the DOM at once.
 *
 * Arrow-key vertical movement steps by a full row (the current column count) instead of
 * one entry; left/right, Enter, Delete, type-ahead and the rest stay the single generic
 * handler `useExplorerKeyboard` already gives every view, so only Up/Down/Left/Right are
 * intercepted here.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import { useFileStore } from "@/stores/file-store";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { activeEntries } from "../use-explorer-keyboard";
import type { ExplorerViewProps } from "./explorer-view-registry";
import { IconsViewTile } from "./icons-view-tile";
import { InlineNameInput } from "./inline-name-input";

/** Tile footprint; the grid fits as many columns as this divides the container width into. */
const TILE_WIDTH = 96;
const TILE_HEIGHT = 88;
/** Matches the grid's own `gap-1` and `p-2`, so a row of tiles never overflows or shrinks. */
const TILE_GAP = 4;
const GRID_PADDING = 16;

export function IconsView({
  slice, entries, actions, selection, inlineError, hasClipboard, isPinned, backgroundLongPress,
}: ExplorerViewProps) {
  const cutPaths = useFileStore((s) => (s.clipboard?.operation === "cut" ? s.clipboard.paths : null));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const usable = el.clientWidth - GRID_PADDING + TILE_GAP;
      setColumns(Math.max(1, Math.floor(usable / (TILE_WIDTH + TILE_GAP))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(entries.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TILE_HEIGHT,
    overscan: 4,
  });

  const anchorIndex = slice.anchor ? entries.findIndex((e) => e.path === slice.anchor) : -1;
  const anchorRow = anchorIndex >= 0 ? Math.floor(anchorIndex / columns) : -1;
  useEffect(() => {
    if (anchorRow >= 0) virtualizer.scrollToIndex(anchorRow, { align: "auto" });
  }, [anchorRow]); // eslint-disable-line react-hooks/exhaustive-deps

  const menuTargets = useMemo(() => activeEntries(slice, entries), [slice, entries]);
  const creating = slice.inlineEdit?.kind === "new-file" || slice.inlineEdit?.kind === "new-folder";

  const onGridKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        event.stopPropagation();
        selection.moveTo(columns, event.shiftKey);
        return;
      case "ArrowUp":
        event.preventDefault();
        event.stopPropagation();
        selection.moveTo(-columns, event.shiftKey);
        return;
      case "ArrowLeft":
        event.preventDefault();
        event.stopPropagation();
        selection.moveTo(-1, event.shiftKey);
        return;
      case "ArrowRight":
        event.preventDefault();
        event.stopPropagation();
        selection.moveTo(1, event.shiftKey);
        return;
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={scrollRef}
          role="grid"
          tabIndex={0}
          data-testid="explorer-icons"
          aria-label="File icons"
          onKeyDown={onGridKeyDown}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) selection.clear();
          }}
          className="h-full flex-1 overflow-auto p-2 outline-none"
          {...backgroundLongPress}
        >
          {creating && (
            <div className="mb-2 flex flex-col items-center gap-1 p-2" style={{ width: TILE_WIDTH }}>
              <InlineNameInput
                initial=""
                error={inlineError}
                onCommit={(value) => void actions.commitInline(value)}
                onCancel={actions.cancelInline}
              />
            </div>
          )}
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const start = row.index * columns;
              const rowEntries = entries.slice(start, start + columns);
              return (
                <div
                  key={row.index}
                  role="row"
                  className="absolute left-0 top-0 flex w-full gap-1"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {rowEntries.map((entry) => (
                    <IconsViewTile
                      key={entry.path}
                      entry={entry}
                      currentDir={slice.path}
                      selected={slice.selection.has(entry.path)}
                      focused={slice.anchor === entry.path}
                      cut={cutPaths?.includes(entry.path) === true}
                      renaming={slice.inlineEdit?.kind === "rename" && slice.inlineEdit.path === entry.path}
                      tileWidth={TILE_WIDTH}
                      menuTargets={slice.selection.has(entry.path) ? menuTargets : [entry]}
                      actions={actions}
                      selection={selection}
                      hasClipboard={hasClipboard}
                      isPinned={isPinned}
                      inlineError={inlineError}
                    />
                  ))}
                </div>
              );
            })}
          </div>
          {entries.length === 0 && !slice.loading && !creating && (
            <p className="p-3 text-xs text-text-subtle">
              {slice.filter ? "No entries match the filter." : "This folder is empty."}
            </p>
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
