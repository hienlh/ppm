/**
 * List view: a sortable header plus virtualised rows.
 *
 * Virtualisation is not optional here — `C:\Windows\System32` is ~5 000 entries and the
 * server hands all of them over in one listing, so only the visible slice may ever be in
 * the DOM.
 */

import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import { useFileStore } from "@/stores/file-store";
import { cn } from "@/lib/utils";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { useExplorerStore, type SortKey } from "../explorer-store";
import { activeEntries } from "../use-explorer-keyboard";
import type { ExplorerViewProps } from "./explorer-view-registry";
import { InlineNameInput } from "./inline-name-input";
import { ListRow } from "./list-row";

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "name", label: "Name", className: "flex-1 text-left" },
  { key: "size", label: "Size", className: "w-20 text-right" },
  { key: "modified", label: "Modified", className: "hidden w-24 text-right sm:block" },
  { key: "kind", label: "Kind", className: "hidden w-16 text-right md:block" },
];

export function ListView({
  slice, entries, actions, selection, inlineError, hasClipboard, isPinned, rowHeight,
}: ExplorerViewProps) {
  const sort = useExplorerStore((s) => s.sort);
  const setPrefs = useExplorerStore((s) => s.setPrefs);
  const cutPaths = useFileStore((s) => (s.clipboard?.operation === "cut" ? s.clipboard.paths : null));
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Keep the cursor row visible when it moved by keyboard rather than by click.
  const anchorIndex = slice.anchor ? entries.findIndex((e) => e.path === slice.anchor) : -1;
  useEffect(() => {
    if (anchorIndex >= 0) virtualizer.scrollToIndex(anchorIndex, { align: "auto" });
  }, [anchorIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  const menuTargets = useMemo(() => activeEntries(slice, entries), [slice, entries]);
  const creating = slice.inlineEdit?.kind === "new-file" || slice.inlineEdit?.kind === "new-folder";

  const toggleSort = (key: SortKey) =>
    setPrefs({ sort: { key, dir: sort.key === key && sort.dir === "asc" ? "desc" : "asc" } });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="row" className="flex shrink-0 items-center gap-2 border-b border-border bg-panel-2 px-2 py-1 text-[11px] font-medium text-text-subtle">
        {COLUMNS.map((column) => (
          <button
            key={column.key}
            type="button"
            aria-label={`Sort by ${column.label}`}
            onClick={() => toggleSort(column.key)}
            className={cn(
              "flex items-center gap-0.5 can-hover:hover:text-text",
              column.className,
              column.key !== "name" && "justify-end",
            )}
          >
            {column.label}
            {sort.key === column.key &&
              (sort.dir === "asc" ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)}
          </button>
        ))}
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            role="grid"
            tabIndex={0}
            data-testid="explorer-list"
            aria-label="File list"
            // Clicking the empty area below the rows clears the selection, as in the OS.
            onMouseDown={(e) => { if (e.target === e.currentTarget) selection.clear(); }}
            className="flex-1 overflow-auto outline-none"
          >
            {creating && (
              <div className="flex items-center gap-2 px-2" style={{ height: rowHeight }}>
                <span className="size-4 shrink-0" />
                <InlineNameInput
                  initial=""
                  error={inlineError}
                  onCommit={(value) => void actions.commitInline(value)}
                  onCancel={actions.cancelInline}
                />
              </div>
            )}
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const entry = entries[item.index]!;
                return (
                  <div
                    key={entry.path}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <ListRow
                      entry={entry}
                      currentDir={slice.path}
                      selected={slice.selection.has(entry.path)}
                      focused={slice.anchor === entry.path}
                      cut={cutPaths?.includes(entry.path) === true}
                      renaming={slice.inlineEdit?.kind === "rename" && slice.inlineEdit.path === entry.path}
                      height={rowHeight}
                      menuTargets={slice.selection.has(entry.path) ? menuTargets : [entry]}
                      actions={actions}
                      selection={selection}
                      hasClipboard={hasClipboard}
                      isPinned={isPinned}
                      inlineError={inlineError}
                    />
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
    </div>
  );
}
