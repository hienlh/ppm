/**
 * One row of the List view: icon, name (or the inline rename field), size, modified, kind.
 *
 * The row is its own context-menu root so a right-click acts on the entry under the
 * cursor, and it carries the coarse-pointer long-press handlers so touch devices wide
 * enough to get the desktop layout still reach the menu.
 */

import { memo } from "react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import { extensionOf } from "../can-open-in-ppm";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { FileTypeIcon } from "../icons/file-type-icon";
import { formatRelativeTime, formatSize } from "../format-file-meta";
import { useCoarseLongPress } from "../use-coarse-long-press";
import type { ExplorerViewProps } from "./explorer-view-registry";
import { InlineNameInput } from "./inline-name-input";

export interface ListRowProps extends Pick<ExplorerViewProps, "actions" | "selection" | "hasClipboard" | "isPinned" | "inlineError"> {
  entry: FsEntry;
  currentDir: string;
  selected: boolean;
  focused: boolean;
  cut: boolean;
  renaming: boolean;
  height: number;
  /** Entries the menu should act on when this row is right-clicked. */
  menuTargets: FsEntry[];
}

export const ListRow = memo(function ListRow({
  entry, currentDir, selected, focused, cut, renaming, height, menuTargets,
  actions, selection, hasClipboard, isPinned, inlineError,
}: ListRowProps) {
  // A press that opens the menu must first make this row the target.
  const longPress = useCoarseLongPress(() => {
    if (!selected) selection.selectOnly(entry.path);
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="row"
          aria-selected={selected}
          data-testid="explorer-row"
          data-path={entry.path}
          title={entry.name}
          style={{ height }}
          {...longPress}
          onContextMenu={() => { if (!selected) selection.selectOnly(entry.path); }}
          onClick={(e) => selection.onRowClick(entry.path, e)}
          onDoubleClick={() => actions.openEntry(entry)}
          className={cn(
            "flex w-full items-center gap-2 px-2 text-[13px] select-none",
            "can-hover:hover:bg-surface-elevated",
            focused && !selected && "bg-surface-elevated",
            selected && "bg-accent-wash",
            cut && "opacity-40",
          )}
        >
          <FileTypeIcon name={entry.name} kind={entry.kind} className="size-4" />
          {renaming ? (
            <InlineNameInput
              initial={entry.name}
              error={inlineError}
              onCommit={(value) => void actions.commitInline(value)}
              onCancel={actions.cancelInline}
            />
          ) : (
            <span className={cn("flex-1 truncate", selected ? "text-text" : "text-text-2")}>
              {entry.name}
            </span>
          )}
          <span className="w-20 shrink-0 text-right tabular-nums text-text-subtle">
            {entry.type === "directory" ? "" : formatSize(entry.size)}
          </span>
          <span className="hidden w-24 shrink-0 text-right text-text-subtle sm:inline">
            {formatRelativeTime(entry.modified)}
          </span>
          <span className="hidden w-16 shrink-0 truncate text-right text-text-subtle md:inline">
            {entry.type === "directory" ? "Folder" : (extensionOf(entry.name) || "File")}
          </span>
        </div>
      </ContextMenuTrigger>
      <ExplorerContextMenu
        targets={menuTargets}
        currentDir={currentDir}
        hasClipboard={hasClipboard}
        isPinned={isPinned}
        actions={actions}
      />
    </ContextMenu>
  );
});
