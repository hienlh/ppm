/**
 * One row inside a Miller column: icon, name, a drill-in chevron for directories. Split out
 * of `column-view-column.tsx` to keep that file under the size budget — the column container
 * and one of its rows are different concerns (virtualised layout vs. a single interactive
 * element).
 */

import { forwardRef, useContext, type HTMLAttributes } from "react";
import { BottomSheetCtx } from "@/components/ui/mobile-bottom-sheet";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import type { ExplorerActions } from "../actions/use-explorer-actions";
import { DROP_TARGET_CLASS } from "../dnd/drop-target-style";
import { useEntryRowDnd } from "../dnd/use-entry-row-dnd";
import { ExplorerContextMenu } from "../explorer-context-menu";
import { FileTypeIcon } from "../icons/file-type-icon";
import { mobileTapAction } from "../mobile/mobile-tap-action";
import { useCoarseLongPress } from "../use-coarse-long-press";
import { composeInteractiveRowProps, type InjectedRowProps } from "./compose-interactive-row-props";

export interface ColumnRowProps {
  entry: FsEntry;
  selected: boolean;
  currentDir: string;
  hasClipboard: boolean;
  isPinned(path: string): boolean;
  actions: ExplorerActions;
  rowHeight: number;
  onSelect(): void;
  onOpen(): void;
}

export function ColumnRow({ entry, selected, currentDir, hasClipboard, isPinned, actions, rowHeight, onSelect, onOpen }: ColumnRowProps) {
  // Column view has no multi-select — a drag always carries just this one entry.
  // Spring-load is Column view's own drill-in gesture (`onSelect` already navigates for a
  // directory), so a rested hover reaches a deep folder without dropping first.
  const dnd = useEntryRowDnd({ entry, dragPaths: [entry.path], run: actions.transferInto, springLoad: onSelect });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ColumnRowInteractive
          entry={entry}
          selected={selected}
          rowHeight={rowHeight}
          onSelect={onSelect}
          onOpen={onOpen}
          dnd={dnd.props}
          dropActive={dnd.isDropTarget}
        />
      </ContextMenuTrigger>
      <ExplorerContextMenu
        targets={[entry]}
        currentDir={currentDir}
        hasClipboard={hasClipboard}
        isPinned={isPinned}
        actions={actions}
      />
    </ContextMenu>
  );
}

/**
 * Rendered inside the row's own `<ContextMenu>` — the position `useContext(BottomSheetCtx)`
 * needs to reach this row's own sheet state (see `use-mobile-row-tap.ts` for the same
 * pattern in List/Icons). Column view keeps its existing single-select semantics on mobile —
 * a directory already navigates on tap via `onSelect`; the only mobile addition is opening a
 * viewable file immediately (no double-click on touch) and surfacing the actions sheet for
 * one that has no viewer, instead of a tap that silently does nothing.
 *
 * `forwardRef` plus `composeInteractiveRowProps` over *everything* injected — not just
 * `onContextMenu` — is required here: `asChild` clones this element and merges its own
 * `onContextMenu` (which actually opens the row's menu), a `ref`, pointer handlers,
 * `data-state` and a `style` that suppresses the native touch callout, but a component that
 * doesn't accept and forward all of them keeps them from ever touching the real DOM node.
 */
export const ColumnRowInteractive = forwardRef<
  HTMLDivElement,
  Pick<ColumnRowProps, "entry" | "selected" | "rowHeight" | "onSelect" | "onOpen"> & InjectedRowProps
>(function ColumnRowInteractive({ entry, selected, rowHeight, onSelect, onOpen, dnd, dropActive, ...injected }, ref) {
  const longPress = useCoarseLongPress(onSelect);
  const isMobile = useIsMobile();
  const { setOpen } = useContext(BottomSheetCtx);

  const handleClick = () => {
    onSelect();
    if (!isMobile || entry.type === "directory") return;
    if (mobileTapAction(entry) === "open") onOpen();
    else setOpen(true);
  };

  const props = composeInteractiveRowProps<Record<string, unknown>>(
    { ...injected, ...longPress, ...dnd },
    {
      role: "option",
      "aria-selected": selected,
      "data-testid": "explorer-column-row",
      "data-path": entry.path,
      title: entry.name,
      style: { height: rowHeight },
      // Radix's own handler is chained in first (it opens this row's menu); only afterwards
      // does this stop the event from also reaching the background trigger further up the DOM.
      onContextMenu: (e: React.MouseEvent) => {
        onSelect();
        e.stopPropagation();
      },
      onClick: handleClick,
      onDoubleClick: onOpen,
      className: cn(
        "flex w-full items-center gap-1.5 px-2 text-[13px] select-none",
        "can-hover:hover:bg-surface-elevated",
        selected && "bg-accent-wash text-text",
        dropActive && DROP_TARGET_CLASS,
      ),
    },
  );

  return (
    <div ref={ref} {...(props as HTMLAttributes<HTMLDivElement>)}>
      <FileTypeIcon name={entry.name} kind={entry.kind} className="size-4 shrink-0" />
      <span className={cn("flex-1 truncate", selected ? "text-text" : "text-text-2")}>{entry.name}</span>
      {entry.type === "directory" && <span className="text-text-subtle">›</span>}
    </div>
  );
});
