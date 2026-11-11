/**
 * The Search panel's result list, virtualised so 20,000 matches render only the rows in
 * view (7.8). Rows come from `buildRows` (`src/web/lib/search/search-rows.ts`); everything
 * stateful (focus, collapsed, dismissed) lives in the search store and arrives as props, so
 * this component only renders and reports.
 *
 * The list is one focusable `role="tree"` with `aria-activedescendant`, like VS Code's:
 * ↑↓←→ Enter move, collapse, expand and open (6.1), Delete dismisses (4.4), Ctrl+Shift+1
 * replaces the focused match or file. Up on the first row hands focus back to the field.
 *
 * Virtualizer setup follows `file-tree.tsx` (direct DOM updates, `containerRef`,
 * `measureElement`, keyed by row id): see `tests/unit/web/explorer-virtual-scroll.test.ts`
 * for why those settings only work as a set. Rows are a fixed 22 px (44 px on a phone).
 */
import { useEffect, useId, useImperativeHandle, useRef, type KeyboardEvent, type Ref } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { moveFocus, type FocusKey, type ReplaceScope, type SearchRow } from "@/lib/search/search-rows";
import type { SearchMatch } from "../../../services/content-search/search-options";
import { ROW_HEIGHT_DESKTOP, ROW_HEIGHT_PHONE, SearchResultRow } from "./search-result-row";

export interface SearchResultsHandle {
  /** Focus the list; the first row becomes the focused one when none is. */
  focus: () => void;
}

export interface SearchResultsProps {
  ref?: Ref<SearchResultsHandle | null>;
  rows: SearchRow[];
  focusedRow: string | null;
  /** A replace text is set: show replacements and offer Replace. */
  hasReplace: boolean;
  /** Phone layout; defaults to the viewport breakpoint. */
  mobile?: boolean;
  onFocusRow: (id: string | null) => void;
  onToggle: (id: string, collapsed: boolean) => void;
  onOpen: (file: string, match: SearchMatch) => void;
  /** A match key, or a file path to dismiss the whole file. */
  onDismiss: (id: string) => void;
  onReplace: (scope: ReplaceScope) => void;
  onCopyPath: (file: string) => void;
  onCollapseAll?: () => void;
  /** Up was pressed on the first row. */
  onExitTop?: () => void;
}

const ARROWS: Record<string, FocusKey> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "enter",
};

/** The row focus lands on once `rows[index]` is dismissed: the next row outside it, else the one before. */
function focusAfterDismiss(rows: SearchRow[], index: number): string | null {
  const gone = rows[index]!;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (gone.kind === "file" && row.kind === "match" && row.file === gone.id) continue;
    return row.id;
  }
  return index > 0 ? rows[index - 1]!.id : null;
}

function isReplaceShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === "Digit1" || e.key === "1" || e.key === "!");
}

export function SearchResults(props: SearchResultsProps) {
  const { ref, rows, focusedRow, hasReplace, onFocusRow, onToggle, onOpen, onDismiss, onReplace } = props;
  const viewportMobile = useIsMobile();
  const mobile = props.mobile ?? viewportMobile;
  const rowHeight = mobile ? ROW_HEIGHT_PHONE : ROW_HEIGHT_DESKTOP;
  const baseId = useId();
  const rowDomId = (index: number) => `${baseId}-row-${index}`;
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    // Keyed by row id, not index: see the note in `file-tree.tsx`.
    getItemKey: (index) => rows[index]?.id ?? `#${index}`,
    overscan: 10,
    directDomUpdates: true,
  });

  const focusedIndex = focusedRow === null ? -1 : rows.findIndex((row) => row.id === focusedRow);

  // Keep the focused row in view. Rows are a fixed height, so its offset is exact and the
  // browser clamps `scrollTop` itself; `scrollToIndex` would clamp to `scrollHeight` instead,
  // which is still 0 when the list has not been laid out yet.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || focusedIndex < 0) return;
    const top = focusedIndex * rowHeight;
    const view = virtualizer.scrollRect?.height ?? el.clientHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + view) el.scrollTop = top + rowHeight - view;
  }, [focusedIndex, rowHeight]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        scrollRef.current?.focus({ preventScroll: true });
        if (focusedIndex < 0 && rows.length > 0) onFocusRow(rows[0]!.id);
      },
    }),
    [focusedIndex, rows, onFocusRow],
  );

  const setFocus = (id: string | null) => {
    if (id !== focusedRow) onFocusRow(id);
  };

  const onRowClick = (index: number) => {
    const row = rows[index];
    if (!row) return;
    scrollRef.current?.focus({ preventScroll: true });
    setFocus(row.id);
    if (row.kind === "match") onOpen(row.file, row.match);
    else onToggle(row.id, !row.collapsed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const row = focusedIndex >= 0 ? rows[focusedIndex]! : null;

    const arrow = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? ARROWS[e.key] : undefined;
    if (arrow) {
      e.preventDefault();
      if (arrow === "up" && focusedIndex === 0 && props.onExitTop) {
        props.onExitTop();
        return;
      }
      const result = moveFocus(rows, focusedRow, arrow);
      setFocus(result.focus);
      if (result.collapse !== undefined) onToggle(result.collapse, true);
      if (result.expand !== undefined) onToggle(result.expand, false);
      if (result.open) onOpen(result.open.file, result.open.match);
      return;
    }

    if (!row) return;
    if (e.key === "Delete" && row.kind !== "folder") {
      e.preventDefault();
      setFocus(focusAfterDismiss(rows, focusedIndex));
      onDismiss(row.id);
      return;
    }
    if (isReplaceShortcut(e) && hasReplace && row.kind !== "folder") {
      e.preventDefault();
      onReplace(row.kind === "match" ? { match: row.id } : { file: row.id });
    }
  };

  return (
    <div
      ref={scrollRef}
      data-search-scroll=""
      role="tree"
      aria-label="Search results"
      tabIndex={0}
      aria-activedescendant={focusedIndex >= 0 ? rowDomId(focusedIndex) : undefined}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
      onKeyDown={onKeyDown}
    >
      <div ref={virtualizer.containerRef} className="relative w-full">
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          return (
            <SearchResultRow
              key={vi.key}
              row={row}
              domId={rowDomId(vi.index)}
              index={vi.index}
              focused={vi.index === focusedIndex}
              hasReplace={hasReplace}
              mobile={mobile}
              onRowClick={onRowClick}
              measureRef={virtualizer.measureElement}
              onDismiss={onDismiss}
              onReplace={onReplace}
              onCopyPath={props.onCopyPath}
              onCollapseAll={props.onCollapseAll}
            />
          );
        })}
      </div>
    </div>
  );
}
