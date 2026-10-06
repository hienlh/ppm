/**
 * One changed file in Source Control: its icon and name, the folder it is in,
 * one dot per block (filled once staged), the line counts, the status letter,
 * and a checkbox that stages or unstages the whole file.
 *
 * The row is a button — tapping it reviews the file's changes, block by
 * block — inside the adaptive context menu's trigger: right-click on a
 * desktop, a long press and a bottom sheet on a phone. The trigger has no tap of its own (it only
 * swallows the click that follows a press), which is why the tap has to be a
 * real button and why no timer is hand-rolled here.
 */
import { useRef } from "react";
import { FileText, Trash2 } from "@/lib/icons";
import { FileIcon } from "@/lib/file-icons";
import { cn } from "@/lib/utils";
import {
  blockDots,
  changeCounts,
  changeLetter,
  fileCheckState,
  hasUnstaged,
  lineNote,
  splitPath,
} from "@/lib/git-changes-view";
import { StartEllipsis } from "@/components/ui/start-ellipsis";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import type { ChangedFile } from "../../../shared/git-changes";
import { BlockDots, CheckCell, LineCounts, StatusTile } from "./git-change-parts";

export interface ChangeRowActions {
  /** The row itself: review the file's changes in the Review changes tab. */
  onOpen: (file: ChangedFile) => void;
  /** The whole file side by side in the diff editor. */
  onOpenDiff: (file: ChangedFile) => void;
  onOpenFile: (file: ChangedFile) => void;
  /**
   * The checkbox: stage everything in the file, or unstage it all once it is
   * all staged. For a conflict it marks it resolved, asking at `anchor` first
   * while git's markers are still in the file.
   */
  onToggle: (file: ChangedFile, anchor?: HTMLElement) => void;
  onStage: (file: ChangedFile, anchor?: HTMLElement) => void;
  onUnstage: (file: ChangedFile) => void;
  /** Pick lines to stage (`index` = to unstage) in the hunk dialog. */
  onPickLines: (file: ChangedFile, scope: "worktree" | "index") => void;
  /** Ask, anchored to `anchor`, then put the unstaged changes back. */
  onDiscard: (file: ChangedFile, anchor: HTMLElement) => void;
  onResolve: (file: ChangedFile) => void;
}

/**
 * The hover tools' backdrop: the hovered row's own colour, fading out to the
 * left so a long name runs under it rather than being cut at an edge.
 */
const TOOLS_BACKDROP =
  "bg-[linear-gradient(to_left,color-mix(in_srgb,var(--text)_8%,var(--panel))_72%,transparent)]";

export function GitChangeRow({ file, nested, busy, actions }: {
  file: ChangedFile;
  /** Inside a folder of the tree view, where the folder line would repeat the heading. */
  nested?: boolean;
  busy: boolean;
  actions: ChangeRowActions;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [dir, name] = splitPath(file.path);
  const letter = changeLetter(file);
  const state = fileCheckState(file);
  const { added, removed } = changeCounts(file);
  const note = lineNote(file);
  const discardable = hasUnstaged(file);
  const open = () => (file.conflict ? actions.onResolve(file) : actions.onOpen(file));
  const discard = (anchor: HTMLElement | null) => {
    if (anchor) actions.onDiscard(file, anchor);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          className="group relative flex min-h-14 md:min-h-10 w-full min-w-0 items-stretch select-none can-hover:hover:bg-surface-hover"
        >
          <button
            type="button"
            className="grid min-w-0 flex-1 grid-cols-[16px_minmax(0,1fr)_auto_18px] items-center gap-2 py-[3px] pl-2.5 text-left"
            onClick={open}
            title={file.conflict ? `Resolve ${file.path}` : `Review ${file.path}`}
          >
            <FileIcon name={file.path} className="size-4" />
            <span className="flex min-w-0 flex-col leading-[1.3]">
              <span
                className={cn(
                  "flex min-w-0 text-sm md:text-[13px] font-medium",
                  letter === "D" && "text-text-2 line-through",
                )}
              >
                <StartEllipsis>{name}</StartEllipsis>
              </span>
              {!nested && dir && (
                <span className="flex min-w-0 text-xs md:text-[11px] text-text-3">
                  <StartEllipsis>{dir}</StartEllipsis>
                </span>
              )}
            </span>
            <span className="flex flex-col items-end gap-1">
              {file.conflict ? (
                <span className="text-xs font-medium text-primary">Resolve</span>
              ) : (
                <>
                  <BlockDots dots={blockDots(file)} />
                  {added + removed > 0 ? (
                    <LineCounts added={added} removed={removed} />
                  ) : note && (
                    <span className="font-mono text-[10.5px] leading-none text-text-3">{note}</span>
                  )}
                </>
              )}
            </span>
            <StatusTile letter={letter} />
          </button>

          {/* Pointer-only shortcuts; a phone reaches the same through the long
              press. Not on a conflict, whose "Resolve" they would cover. */}
          {!file.conflict && (
            <div
              className={cn(
                "absolute inset-y-0 right-[30px] hidden md:flex items-center gap-0.5 pl-[22px] pr-0.5 transition-opacity",
                "can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-within:opacity-100",
                TOOLS_BACKDROP,
              )}
            >
              <button
                type="button"
                className="grid size-6 place-items-center rounded-[5px] text-text-3 hover:bg-text/8 hover:text-text"
                title="Open file"
                aria-label={`Open ${name}`}
                onClick={() => actions.onOpenFile(file)}
              >
                <FileText className="size-3.5" />
              </button>
              <button
                type="button"
                className="grid size-6 place-items-center rounded-[5px] text-text-3 hover:bg-text/8 hover:text-error disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-3"
                title={discardable ? "Discard changes…" : "Only staged changes left"}
                aria-label={`Discard changes to ${name}`}
                disabled={!discardable || busy}
                onClick={(e) => discard(e.currentTarget)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )}

          <CheckCell
            state={state}
            disabled={busy}
            label={file.conflict ? `Mark ${name} resolved` : `${state === "all" ? "Unstage" : "Stage"} ${name}`}
            title={file.conflict ? "Mark as resolved" : state === "all" ? "Unstage file" : "Stage file"}
            onToggle={() => actions.onToggle(file, rowRef.current ?? undefined)}
          />
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-44">
        {file.conflict ? (
          <>
            <ContextMenuItem onClick={() => actions.onResolve(file)}>Resolve conflict</ContextMenuItem>
            <ContextMenuItem onClick={() => actions.onOpenFile(file)}>Open file</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => actions.onStage(file, rowRef.current ?? undefined)} disabled={busy}>
              Mark as resolved
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onClick={() => actions.onOpen(file)}>Review changes</ContextMenuItem>
            <ContextMenuItem onClick={() => actions.onOpenDiff(file)}>Open diff</ContextMenuItem>
            <ContextMenuItem onClick={() => actions.onOpenFile(file)}>Open file</ContextMenuItem>
            <ContextMenuSeparator />
            {state !== "all" && (
              <ContextMenuItem onClick={() => actions.onStage(file)} disabled={busy}>Stage file</ContextMenuItem>
            )}
            {state !== "none" && (
              <ContextMenuItem onClick={() => actions.onUnstage(file)} disabled={busy}>Unstage file</ContextMenuItem>
            )}
            {file.unstaged && (
              <ContextMenuItem onClick={() => actions.onPickLines(file, "worktree")} disabled={busy}>
                Stage lines…
              </ContextMenuItem>
            )}
            {file.staged && (
              <ContextMenuItem onClick={() => actions.onPickLines(file, "index")} disabled={busy}>
                Unstage lines…
              </ContextMenuItem>
            )}
            {discardable && (
              <>
                {/* Set apart, because on a sheet these rows are 44px tall and sit
                    where the thumb already is. */}
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={() => discard(rowRef.current)} disabled={busy}>
                  Discard changes…
                </ContextMenuItem>
              </>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
