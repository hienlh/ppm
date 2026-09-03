/**
 * One tile in the Icons view grid: a large glyph (file-type icon, or an image thumbnail
 * once it scrolls into view) above a two-line truncated label. Selection, long-press and
 * context-menu wiring mirror `ListRow` so switching views never changes what a row/tile
 * can do, only how it looks — including the mobile tap/select-mode branch, see
 * `useMobileRowTap`.
 */

import { forwardRef, memo, useMemo, type HTMLAttributes } from "react";
import { Check } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import { viewerKindOf } from "../can-open-in-ppm";
import { DROP_TARGET_CLASS } from "../dnd/drop-target-style";
import { useEntryRowDnd } from "../dnd/use-entry-row-dnd";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { FileTypeIcon } from "../icons/file-type-icon";
import { ThumbnailImage } from "../icons/thumbnail-image";
import { useMobileRowTap } from "../mobile/use-mobile-row-tap";
import { useCoarseLongPress } from "../use-coarse-long-press";
import { composeInteractiveRowProps, type InjectedRowProps } from "./compose-interactive-row-props";
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
  // A drag carries whatever a context menu would act on: the selection when this tile is
  // part of it, otherwise just this tile.
  const dragPaths = useMemo(() => menuTargets.map((target) => target.path), [menuTargets]);
  const dnd = useEntryRowDnd({ entry, dragPaths, run: actions.transferInto });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <IconsViewTileInteractive {...props} dnd={dnd.props} dropActive={dnd.isDropTarget} />
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
 * `forwardRef` plus `composeInteractiveRowProps` over *everything* injected — not just
 * `onContextMenu` — is required here: `asChild` clones this element and merges its own
 * `onContextMenu` (which actually opens the tile's menu), a `ref`, pointer handlers,
 * `data-state` and a `style` that suppresses the native touch callout, but a component that
 * doesn't accept and forward all of them keeps them from ever touching the real DOM node.
 */
export const IconsViewTileInteractive = forwardRef<HTMLDivElement, IconsViewTileProps & InjectedRowProps>(
  function IconsViewTileInteractive(
    {
      entry, selected, focused, cut, renaming, tileWidth, actions, selection, inlineError,
      currentDir: _currentDir, hasClipboard: _hasClipboard, isPinned: _isPinned, menuTargets: _menuTargets,
      dnd, dropActive, ...injected
    },
    ref,
  ) {
    const longPress = useCoarseLongPress(() => {
      if (!selected) selection.selectOnly(entry.path);
    });
    const { isMobile, selectMode, handleTap } = useMobileRowTap(actions, selection);
    const isImage = entry.type !== "directory" && viewerKindOf(entry.name) === "image";

    const props = composeInteractiveRowProps<Record<string, unknown>>(
      { ...injected, ...longPress, ...dnd },
      {
        role: "gridcell",
        "aria-selected": selected,
        "data-testid": "explorer-tile",
        "data-path": entry.path,
        title: entry.name,
        style: tileWidth ? { width: tileWidth } : undefined,
        // Radix's own handler is chained in first (it opens this tile's menu); only
        // afterwards does this stop the event from also reaching the background trigger
        // further up the DOM.
        onContextMenu: (e: React.MouseEvent) => {
          if (!selected) selection.selectOnly(entry.path);
          e.stopPropagation();
        },
        onClick: (e: React.MouseEvent) => {
          if (!handleTap(entry, selected)) selection.onRowClick(entry.path, e);
        },
        onDoubleClick: () => actions.openEntry(entry),
        className: cn(
          "relative flex flex-col items-center gap-1 rounded p-2 text-center select-none",
          !tileWidth && "w-full",
          "can-hover:hover:bg-surface-elevated",
          focused && !selected && "bg-surface-elevated",
          selected && "bg-accent-wash",
          cut && "opacity-40",
          dropActive && DROP_TARGET_CLASS,
        ),
      },
    );

    return (
      <div ref={ref} {...(props as HTMLAttributes<HTMLDivElement>)}>
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
