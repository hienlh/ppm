/**
 * One row of the List view: icon, name (or the inline rename field), size, modified, kind.
 *
 * The row is its own context-menu root so a right-click acts on the entry under the
 * cursor, and it carries the coarse-pointer long-press handlers so touch devices wide
 * enough to get the desktop layout still reach the menu.
 *
 * On the mobile sheet specifically, a tap replaces desktop's click-to-select: there is no
 * double-click on touch, so a directory or a viewable file must open on the first tap (see
 * `useMobileRowTap`), and "Select" mode swaps the tap for a checkbox toggle.
 */

import { memo } from "react";
import { Check } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import { extensionOf } from "../can-open-in-ppm";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { FileTypeIcon } from "../icons/file-type-icon";
import { formatRelativeTime, formatSize } from "../format-file-meta";
import { useMobileRowTap } from "../mobile/use-mobile-row-tap";
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

export const ListRow = memo(function ListRow(props: ListRowProps) {
  const { entry, currentDir, selected, hasClipboard, isPinned, actions, menuTargets } = props;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ListRowInteractive {...props} />
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
 * Rendered inside the row's own `<ContextMenu>` (not by the memo above, which renders that
 * provider) — the position `useMobileRowTap` needs to reach this row's own sheet state.
 */
function ListRowInteractive({
  entry, selected, focused, cut, renaming, height, actions, selection, inlineError,
}: ListRowProps) {
  const longPress = useCoarseLongPress(() => {
    if (!selected) selection.selectOnly(entry.path);
  });
  const { isMobile, selectMode, handleTap } = useMobileRowTap(actions, selection);

  return (
    <div
      role="row"
      aria-selected={selected}
      data-testid="explorer-row"
      data-path={entry.path}
      title={entry.name}
      style={{ height }}
      {...longPress}
      onContextMenu={() => { if (!selected) selection.selectOnly(entry.path); }}
      onClick={(e) => { if (!handleTap(entry, selected)) selection.onRowClick(entry.path, e); }}
      onDoubleClick={() => actions.openEntry(entry)}
      className={cn(
        "flex w-full items-center gap-2 px-2 text-[13px] select-none",
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
            "flex size-5 shrink-0 items-center justify-center rounded border",
            selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
          )}
        >
          {selected && <Check className="size-3.5" />}
        </span>
      )}
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
  );
}
