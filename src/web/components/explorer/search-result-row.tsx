/**
 * One row of the Search panel's result list: a folder (tree view), a file, or a match.
 *
 * A match shows the slice of its line the server cut (`before` · match · `after`, with "…"
 * when `before` was cut), and highlights exactly the server's `text` — never a range
 * recomputed in the browser (3.4). With a replace text set it shows the old text struck
 * through beside the new one (5.1).
 *
 * Actions show on hover or focus on desktop (`data-actions="hover"`) and always on a phone
 * (`data-actions="always"`, 44 px targets), where a file's actions sit in a bottom sheet
 * behind its ··· button (6.7). Action buttons stop the click, so they never open or toggle.
 */
import { useState, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Copy, Folder, FolderOpen, MoreHorizontal, ReplaceAll, X } from "@/lib/icons";
import { FileIcon } from "@/lib/file-icons";
import { cn } from "@/lib/utils";
import { BottomSheet, BottomSheetCtx, BottomSheetItem } from "@/components/ui/mobile-bottom-sheet";
import type { FileRow, FolderRow, MatchRow, ReplaceScope, SearchRow } from "@/lib/search/search-rows";

export const ROW_HEIGHT_DESKTOP = 22;
export const ROW_HEIGHT_PHONE = 44;

export interface SearchResultRowActions {
  onDismiss: (id: string) => void;
  onReplace: (scope: ReplaceScope) => void;
  onCopyPath: (file: string) => void;
  onCollapseAll?: () => void;
}

interface SearchResultRowProps extends SearchResultRowActions {
  row: SearchRow;
  /** DOM id, so the list can point `aria-activedescendant` at it. */
  domId: string;
  index: number;
  focused: boolean;
  hasReplace: boolean;
  mobile: boolean;
  /** Called with the row's index; the list decides what a click does. */
  onRowClick: (index: number) => void;
  /** The virtualizer's sizing callback (`measureElement`). */
  measureRef: (el: HTMLElement | null) => void;
}

const INDENT = 12;

export function SearchResultRow(props: SearchResultRowProps) {
  const { row, domId, index, focused, mobile, onRowClick, measureRef } = props;
  const height = mobile ? ROW_HEIGHT_PHONE : ROW_HEIGHT_DESKTOP;
  const indent = (mobile ? 12 : 6) + row.depth * INDENT + (row.kind === "match" ? (mobile ? 24 : 18) : 0);

  return (
    <div
      id={domId}
      ref={measureRef}
      data-index={index}
      data-row-id={row.id}
      data-kind={row.kind}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={focused}
      aria-expanded={row.kind === "match" ? undefined : !row.collapsed}
      className={cn(
        "group absolute left-0 top-0 w-full flex items-center gap-1 pr-1.5 cursor-pointer select-none",
        mobile ? "text-sm" : "text-xs",
        "hover:bg-surface-hover",
        focused && "bg-accent-wash shadow-[inset_2px_0_0_var(--color-accent)]",
      )}
      style={{ height, paddingLeft: indent }}
      onClick={() => onRowClick(index)}
    >
      {row.kind === "folder" && <FolderContent row={row} mobile={mobile} />}
      {row.kind === "file" && <FileContent {...props} row={row} />}
      {row.kind === "match" && <MatchContent {...props} row={row} />}
    </div>
  );
}

function Chevron({ collapsed, mobile }: { collapsed: boolean; mobile: boolean }) {
  const Icon = collapsed ? ChevronRight : ChevronDown;
  return <Icon className={cn("shrink-0 text-text-subtle", mobile ? "size-3.5" : "size-3")} />;
}

function CountBadge({ count, hideOnHover }: { count: number; hideOnHover: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border border-border px-1.5 text-[10px] tabular-nums text-text-secondary bg-surface",
        hideOnHover && "group-hover:hidden group-focus-within:hidden",
      )}
    >
      {count}
    </span>
  );
}

function FolderContent({ row, mobile }: { row: FolderRow; mobile: boolean }) {
  const Icon = row.collapsed ? Folder : FolderOpen;
  return (
    <>
      <Chevron collapsed={row.collapsed} mobile={mobile} />
      <Icon className="size-3.5 shrink-0 text-text-secondary" />
      <span className="truncate text-text-secondary">{row.name}</span>
      <span className="flex-1" />
      <CountBadge count={row.count} hideOnHover={false} />
    </>
  );
}

function ActionButton({
  label,
  title,
  mobile,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  mobile: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      tabIndex={-1}
      className={cn(
        "grid place-items-center rounded text-text-secondary hover:bg-surface-hover hover:text-foreground",
        mobile ? "size-11" : "size-5",
      )}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function Actions({ mobile, focused, children }: { mobile: boolean; focused: boolean; children: ReactNode }) {
  return (
    <span
      data-actions={mobile ? "always" : "hover"}
      className={cn(
        "shrink-0 items-center gap-px",
        mobile || focused ? "flex" : "hidden group-hover:flex group-focus-within:flex",
      )}
    >
      {children}
    </span>
  );
}

function FileContent(props: SearchResultRowProps & { row: FileRow }) {
  const { row, mobile, focused, hasReplace, onDismiss, onReplace, onCopyPath, onCollapseAll } = props;
  const [sheetOpen, setSheetOpen] = useState(false);
  const iconSize = mobile ? "size-4" : "size-3.5";

  return (
    <>
      <Chevron collapsed={row.collapsed} mobile={mobile} />
      <FileIcon name={row.name} className={cn(iconSize, "shrink-0")} />
      <span className="shrink-0 whitespace-nowrap font-medium text-foreground">{row.name}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-text-subtle">{row.dir}</span>
      <CountBadge count={row.count} hideOnHover={!mobile} />
      {mobile ? (
        <>
          <ActionButton label="More actions" mobile onClick={() => setSheetOpen(true)}>
            <MoreHorizontal className="size-[18px]" />
          </ActionButton>
          <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
            <BottomSheetCtx.Provider value={{ open: sheetOpen, setOpen: setSheetOpen }}>
              <div data-search-file-sheet="" className="px-2 pb-2" onClick={(e) => e.stopPropagation()}>
                <div className="truncate px-3 py-2 text-xs text-text-subtle">{row.id}</div>
                {hasReplace && (
                  <BottomSheetItem onClick={() => onReplace({ file: row.id })}>
                    <ReplaceAll /> Replace All in File
                  </BottomSheetItem>
                )}
                <BottomSheetItem onClick={() => onCopyPath(row.id)}>
                  <Copy /> Copy Path
                </BottomSheetItem>
                <BottomSheetItem onClick={() => onDismiss(row.id)}>
                  <X /> Dismiss
                </BottomSheetItem>
                {onCollapseAll && (
                  <BottomSheetItem onClick={() => onCollapseAll()}>
                    <ChevronRight /> Collapse All
                  </BottomSheetItem>
                )}
              </div>
            </BottomSheetCtx.Provider>
          </BottomSheet>
        </>
      ) : (
        <Actions mobile={false} focused={focused}>
          {hasReplace && (
            <ActionButton label="Replace All in File" mobile={false} onClick={() => onReplace({ file: row.id })}>
              <ReplaceAll className="size-3.5" />
            </ActionButton>
          )}
          <ActionButton label="Copy Path" mobile={false} onClick={() => onCopyPath(row.id)}>
            <Copy className="size-3.5" />
          </ActionButton>
          <ActionButton label="Dismiss" mobile={false} onClick={() => onDismiss(row.id)}>
            <X className="size-3.5" />
          </ActionButton>
        </Actions>
      )}
    </>
  );
}

function MatchContent(props: SearchResultRowProps & { row: MatchRow }) {
  const { row, mobile, focused, hasReplace, onDismiss, onReplace } = props;
  const { match } = row;
  const showReplace = hasReplace && match.replacement !== undefined;

  return (
    <>
      <span
        className={cn(
          "min-w-0 flex-1 overflow-hidden whitespace-pre font-mono text-text-secondary",
          mobile ? "text-[13px]" : "text-[11.5px]",
        )}
      >
        {match.cutBefore && <span className="text-text-subtle">…</span>}
        {match.before}
        {showReplace ? (
          <>
            <del className="rounded-sm bg-diff-removed text-foreground">{match.text}</del>
            <ins className="rounded-sm bg-diff-added text-foreground no-underline">{match.replacement}</ins>
          </>
        ) : (
          <mark className="rounded-sm bg-warning/40 text-foreground">{match.text}</mark>
        )}
        {match.after}
      </span>
      <Actions mobile={mobile} focused={focused}>
        {hasReplace && (
          <ActionButton
            label="Replace"
            title="Replace (Ctrl+Shift+1)"
            mobile={mobile}
            onClick={() => onReplace({ match: row.id })}
          >
            <ReplaceAll className={mobile ? "size-[18px]" : "size-3.5"} />
          </ActionButton>
        )}
        <ActionButton label="Dismiss" title="Dismiss (Delete)" mobile={mobile} onClick={() => onDismiss(row.id)}>
          <X className={mobile ? "size-[18px]" : "size-3.5"} />
        </ActionButton>
      </Actions>
    </>
  );
}
