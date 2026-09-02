/**
 * One tile in the Icons view grid: a large glyph (file-type icon, or an image thumbnail
 * once it scrolls into view) above a two-line truncated label. Selection, long-press and
 * context-menu wiring mirror `ListRow` so switching views never changes what a row/tile
 * can do, only how it looks — including the mobile tap/select-mode branch, see
 * `useMobileRowTap`.
 */

import { forwardRef, memo, type MouseEventHandler } from "react";
import { Check } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import { viewerKindOf } from "../can-open-in-ppm";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { FileTypeIcon } from "../icons/file-type-icon";
import { ThumbnailImage } from "../icons/thumbnail-image";
import { useMobileRowTap } from "../mobile/use-mobile-row-tap";
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
  /** Fixed pixel width on desktop; `undefined` on mobile, where a CSS grid column sizes it. */
  tileWidth: number | undefined;
  /** Entries the menu should act on when this tile is right-clicked. */
  menuTargets: FsEntry[];
}

export const IconsViewTile = memo(function IconsViewTile(props: IconsViewTileProps) {
  const { entry, currentDir, hasClipboard, isPinned, actions, menuTargets } = props;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <IconsViewTileInteractive {...props} />
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

/**
 * Rendered inside the tile's own `<ContextMenu>` — see `useMobileRowTap`'s doc comment.
 *
 * `forwardRef` plus explicitly accepting `onContextMenu` is required here: `asChild` clones
 * this element and merges its own `onContextMenu` (which actually opens the tile's menu)
 * plus a `ref` onto it, but a plain function component that doesn't accept and forward
 * those two silently drops them — the tile still ran its own selection logic, but no menu
 * ever opened.
 */
export const IconsViewTileInteractive = forwardRef<HTMLDivElement, IconsViewTileProps & { onContextMenu?: MouseEventHandler<HTMLDivElement> }>(
  function IconsViewTileInteractive(
    { entry, selected, focused, cut, renaming, tileWidth, actions, selection, inlineError, onContextMenu },
    ref,
  ) {
    const longPress = useCoarseLongPress(() => {
      if (!selected) selection.selectOnly(entry.path);
    });
    const { isMobile, selectMode, handleTap } = useMobileRowTap(actions, selection);
    const isImage = entry.type !== "directory" && viewerKindOf(entry.name) === "image";

    return (
      <div
        ref={ref}
        role="gridcell"
        aria-selected={selected}
        data-testid="explorer-tile"
        data-path={entry.path}
        title={entry.name}
        style={tileWidth ? { width: tileWidth } : undefined}
        {...longPress}
        onContextMenu={(e) => {
          // Run Radix's own handler first (it opens this tile's menu); only afterwards stop
          // the event from also reaching the background trigger further up the DOM.
          onContextMenu?.(e);
          if (!selected) selection.selectOnly(entry.path);
          e.stopPropagation();
        }}
        onClick={(e) => { if (!handleTap(entry, selected)) selection.onRowClick(entry.path, e); }}
        onDoubleClick={() => actions.openEntry(entry)}
        className={cn(
          "relative flex flex-col items-center gap-1 rounded p-2 text-center select-none",
          !tileWidth && "w-full",
          "can-hover:hover:bg-surface-elevated",
          focused && !selected && "bg-surface-elevated",
          selected && "bg-accent-wash",
          cut && "opacity-40",
        )}
      >
        {isMobile && selectMode && (
          <span
            aria-hidden
            className={cn(
              "absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded border",
              selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-panel",
            )}
          >
            {selected && <Check className="size-3.5" />}
          </span>
        )}
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
    );
  },
);
