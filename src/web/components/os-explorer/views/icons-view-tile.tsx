/**
 * One tile in the Icons view grid: a large glyph (file-type icon, or an image thumbnail
 * once it scrolls into view) above a two-line truncated label. Selection, long-press and
 * context-menu wiring mirror `ListRow` so switching views never changes what a row/tile
 * can do, only how it looks.
 */

import { memo } from "react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import { viewerKindOf } from "../can-open-in-ppm";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { FileTypeIcon } from "../icons/file-type-icon";
import { ThumbnailImage } from "../icons/thumbnail-image";
import { useCoarseLongPress } from "../use-coarse-long-press";
import type { ExplorerViewProps } from "./explorer-view-registry";
import { InlineNameInput } from "./inline-name-input";

export interface IconsViewTileProps
  extends Pick<ExplorerViewProps, "actions" | "selection" | "hasClipboard" | "isPinned" | "inlineError"> {
  entry: FsEntry;
  currentDir: string;
  selected: boolean;
  focused: boolean;
  cut: boolean;
  renaming: boolean;
  tileWidth: number;
  /** Entries the menu should act on when this tile is right-clicked. */
  menuTargets: FsEntry[];
}

export const IconsViewTile = memo(function IconsViewTile({
  entry, currentDir, selected, focused, cut, renaming, tileWidth, menuTargets,
  actions, selection, hasClipboard, isPinned, inlineError,
}: IconsViewTileProps) {
  const longPress = useCoarseLongPress(() => {
    if (!selected) selection.selectOnly(entry.path);
  });
  const isImage = entry.type !== "directory" && viewerKindOf(entry.name) === "image";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="gridcell"
          aria-selected={selected}
          data-testid="explorer-tile"
          data-path={entry.path}
          title={entry.name}
          style={{ width: tileWidth }}
          {...longPress}
          onContextMenu={() => {
            if (!selected) selection.selectOnly(entry.path);
          }}
          onClick={(e) => selection.onRowClick(entry.path, e)}
          onDoubleClick={() => actions.openEntry(entry)}
          className={cn(
            "flex flex-col items-center gap-1 rounded p-2 text-center select-none",
            "can-hover:hover:bg-surface-elevated",
            focused && !selected && "bg-surface-elevated",
            selected && "bg-accent-wash",
            cut && "opacity-40",
          )}
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center">
            {isImage ? (
              <ThumbnailImage entry={entry} size={48} />
            ) : (
              <FileTypeIcon name={entry.name} kind={entry.kind} className="size-12" />
            )}
          </div>
          {renaming ? (
            <InlineNameInput
              initial={entry.name}
              error={inlineError}
              onCommit={(value) => void actions.commitInline(value)}
              onCancel={actions.cancelInline}
            />
          ) : (
            <span
              className={cn(
                "line-clamp-2 w-full break-words text-[12px] leading-tight",
                selected ? "text-text" : "text-text-2",
              )}
            >
              {entry.name}
            </span>
          )}
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
