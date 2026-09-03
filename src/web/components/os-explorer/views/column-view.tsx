/**
 * Column (Miller) view: one fixed-width column per breadcrumb ancestor, plus a preview
 * pane for the selected leaf file. Drilling into a directory — by click or arrow key — is
 * just `nav.go`, the same call the toolbar's back/forward/breadcrumb use, so history and
 * the breadcrumb agree with whatever this view is showing and switching to List/Icons
 * never loses the place.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { FsEntry } from "@/lib/fs-api";
import { useDragAutoScroll } from "../dnd/use-drag-auto-scroll";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { ColumnViewColumn } from "./column-view-column";
import { ColumnViewMobile } from "./column-view-mobile";
import { ColumnViewPreview } from "./column-view-preview";
import type { ExplorerViewProps } from "./explorer-view-registry";
import { useColumnViewState } from "./use-column-view-state";

/** Below this window width the preview pane would leave no room for the columns themselves. */
const NARROW_PREVIEW_THRESHOLD = 720;

export function ColumnView({
  slice, entries, actions, selection, hasClipboard, isPinned, nav, backgroundLongPress, rowHeight,
}: ExplorerViewProps) {
  const paths = useMemo(
    () => (slice.breadcrumbs.length > 0 ? slice.breadcrumbs.map((b) => b.path) : [slice.path]),
    [slice.breadcrumbs, slice.path],
  );
  const { columns } = useColumnViewState(paths, entries, slice.loading);
  const isMobile = useIsMobile();

  const containerRef = useRef<HTMLDivElement>(null);
  // Horizontal auto-scroll across the Miller strip itself; each column also scrolls
  // vertically on its own (see `column-view-column.tsx`). Harmless on mobile — no drag
  // source ever fires a `dragover` there, since `draggable` is withheld on coarse pointers.
  useDragAutoScroll(containerRef);
  const [focusedIndex, setFocusedIndex] = useState(columns.length - 1);
  const [containerWidth, setContainerWidth] = useState(0);
  const prevLength = useRef(columns.length);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A new column (deeper drill, or a fresh window) moves the keyboard cursor onto it and
  // scrolls it into view — every Miller browser keeps the newest column in frame.
  useEffect(() => {
    if (columns.length === prevLength.current) return;
    prevLength.current = columns.length;
    setFocusedIndex(columns.length - 1);
    const el = containerRef.current;
    if (!el) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    el.scrollTo({ left: el.scrollWidth, behavior: reduceMotion ? "auto" : "smooth" });
  }, [columns.length]);

  // The preview pane follows the shared window selection wherever it lands, even in an
  // earlier column — the deepest column is just the common case.
  const previewEntry: FsEntry | null = useMemo(() => {
    if (!slice.anchor) return null;
    for (const column of columns) {
      const found = column.entries.find((e) => e.path === slice.anchor);
      if (found) return found;
    }
    return null;
  }, [columns, slice.anchor]);

  const selectedPathFor = (index: number): string | null =>
    index === columns.length - 1 ? slice.anchor : (columns[index + 1]?.path ?? null);

  const entryAt = (index: number): FsEntry | null => {
    const column = columns[index];
    if (!column) return null;
    const path = selectedPathFor(index);
    return column.entries.find((e) => e.path === path) ?? null;
  };

  const handleSelect = (index: number, entry: FsEntry) => {
    setFocusedIndex(index);
    if (entry.type === "directory") nav.go(entry.path);
    else selection.selectOnly(entry.path);
  };

  const handleOpen = (entry: FsEntry) => actions.openEntry(entry);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === "ArrowRight" && focusedIndex < columns.length - 1) {
      event.preventDefault();
      event.stopPropagation();
      setFocusedIndex(focusedIndex + 1);
      return;
    }
    if (event.key === "ArrowLeft" && focusedIndex > 0) {
      event.preventDefault();
      event.stopPropagation();
      setFocusedIndex(focusedIndex - 1);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const column = columns[focusedIndex];
      if (!column) return;
      event.preventDefault();
      event.stopPropagation();
      const current = entryAt(focusedIndex);
      const currentIndex = current ? column.entries.findIndex((e) => e.path === current.path) : -1;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.min(column.entries.length - 1, Math.max(0, currentIndex < 0 ? 0 : currentIndex + delta));
      const next = column.entries[nextIndex];
      if (next) handleSelect(focusedIndex, next);
      return;
    }
    if (event.key === "Enter") {
      const current = entryAt(focusedIndex);
      if (current) {
        event.preventDefault();
        event.stopPropagation();
        handleOpen(current);
      }
    }
  };

  // Defaults hidden (not shown) before the ResizeObserver's first report — showing it then
  // hiding it a frame later on a narrow window is a worse flash than the reverse.
  const showPreview = containerWidth >= NARROW_PREVIEW_THRESHOLD;

  // Mobile has no room for a side-by-side Miller strip — see `column-view-mobile.tsx`.
  if (isMobile) {
    return (
      <ColumnViewMobile
        containerRef={containerRef}
        onKeyDown={onKeyDown}
        backgroundLongPress={backgroundLongPress}
        columns={columns}
        focusedIndex={focusedIndex}
        setFocusedIndex={setFocusedIndex}
        selectedPathFor={selectedPathFor}
        slice={slice}
        hasClipboard={hasClipboard}
        isPinned={isPinned}
        actions={actions}
        onSelect={handleSelect}
        onOpen={handleOpen}
      />
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          tabIndex={0}
          data-testid="explorer-columns"
          aria-label="Column view"
          onKeyDown={onKeyDown}
          className="flex h-full min-h-0 w-full overflow-x-auto outline-none"
          {...backgroundLongPress}
        >
          {columns.map((column, index) => (
            <ColumnViewColumn
              key={column.path}
              path={column.path}
              entries={column.entries}
              loading={column.loading}
              error={column.error}
              selectedPath={selectedPathFor(index)}
              isFocused={index === focusedIndex}
              currentDir={slice.path}
              hasClipboard={hasClipboard}
              isPinned={isPinned}
              actions={actions}
              rowHeight={rowHeight}
              onSelect={(entry) => handleSelect(index, entry)}
              onOpen={handleOpen}
              onFocus={() => setFocusedIndex(index)}
            />
          ))}
          {showPreview && (
            <div className="min-w-[240px] flex-1 border-l border-border bg-panel-2/30">
              <ColumnViewPreview entry={previewEntry} onOpen={handleOpen} />
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
