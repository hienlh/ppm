/**
 * Every file this chat session has changed, pinned above the composer: "N files changed
 * +X −Y", which opens into the list — inline on desktop, a bottom sheet on a phone — and a
 * Review button for the multi-file diff tab. Cumulative across turns, where the chip under
 * each answer covers that turn only.
 *
 * A file marked reviewed leaves the list and the totals until the agent changes it again,
 * behind one "N reviewed" row that brings them back; with every file reviewed the bar shrinks
 * to that one line.
 *
 * What the list cannot see is said in the list. Claude's shell commands are followed through
 * git, so a file outside a repository or ignored by one took no "before" copy; another
 * agent's shell commands are not followed at all. Those files are only in Source Control.
 */
import { useId, useState } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useProjectStore } from "@/stores/project-store";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { CheckCircle2, ChevronRight, Eye, EyeOff, FileDiff, ListChecks, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { fileCount, sessionChangeTotals, splitReviewed } from "@/lib/session-file-changes";
import { ChangeCounts } from "./change-file-row";
import { SessionChangeRow } from "./session-change-row";
import type { SessionFileChange } from "../../../shared/session-file-changes";

/** What the list leaves out of a session run by `providerId`. */
export function shellChangesHint(providerId?: string): string {
  return providerId === "claude"
    ? "Shell commands are followed through git: a file outside a repository, or one git ignores, is not listed. Source Control shows everything on disk."
    : "Files changed by shell commands are not listed — Source Control shows everything on disk.";
}

/** The row that hides or shows the files marked reviewed. */
export function ReviewedToggle({ count, shown, dense, onToggle }: {
  count: number;
  shown: boolean;
  dense?: boolean;
  onToggle: () => void;
}) {
  const Icon = shown ? EyeOff : Eye;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={shown}
      className={cn(
        "flex w-full items-center gap-2 border-b border-border-soft text-left text-text-secondary transition-colors hover:bg-surface",
        dense ? "min-h-8 px-2.5 text-[11px]" : "min-h-11 px-3 text-xs",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex-1">{count} reviewed</span>
      <span className="text-text-subtle">{shown ? "Hide" : "Show"}</span>
    </button>
  );
}

export function SessionChangesBar({ files, projectName, providerId, onReview, onOpen, onSetReviewed }: {
  files: SessionFileChange[];
  projectName: string;
  providerId?: string;
  /** Open the Review tab, on `path` when one was picked. */
  onReview: (path?: string) => void;
  /** The list was opened: worth asking the server again, the disk may have moved. */
  onOpen?: () => void;
  /** Mark files reviewed (hidden until they change again), or bring them back. */
  onSetReviewed?: (files: SessionFileChange[], reviewed: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showReviewed, setShowReviewed] = useState(false);
  const isMobile = useIsMobile();
  const listId = useId();
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.name === projectName)?.path);

  if (files.length === 0) return null;

  const { pending, reviewed } = splitReviewed(files);
  const allReviewed = pending.length === 0;
  // Nothing else to show once every file is reviewed.
  const reviewedShown = showReviewed || allReviewed;
  const totals = sessionChangeTotals(pending);
  const label = allReviewed ? `All ${fileCount(reviewed.length)} reviewed` : `${fileCount(pending.length)} changed`;
  const toggle = () => {
    if (!open) onOpen?.();
    setOpen(!open);
  };
  const review = (path?: string) => {
    setOpen(false);
    onReview(path);
  };
  const markAll = () => {
    setOpen(false);
    onSetReviewed?.(pending, true);
  };

  const row = (file: SessionFileChange, dense: boolean) => (
    <SessionChangeRow
      key={file.path}
      file={file}
      projectPath={projectPath}
      dense={dense}
      onClick={() => review(file.path)}
      onToggleReviewed={onSetReviewed ? () => onSetReviewed([file], !file.reviewed) : undefined}
    />
  );
  const rows = (dense: boolean) => (
    <>
      {pending.map((file) => row(file, dense))}
      {reviewed.length > 0 && !allReviewed && (
        <ReviewedToggle count={reviewed.length} shown={showReviewed} dense={dense} onToggle={() => setShowReviewed(!showReviewed)} />
      )}
      {reviewedShown && reviewed.map((file) => row(file, dense))}
    </>
  );

  return (
    <div className="shrink-0 border-t border-border bg-surface-elevated/60" data-testid="session-changes-bar">
      <div className="flex items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={isMobile ? undefined : listId}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded px-1 text-left text-xs transition-colors hover:bg-surface md:min-h-8"
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-text-subtle transition-transform", open && !isMobile && "rotate-90")}
          />
          {allReviewed && <CheckCircle2 className="size-3.5 shrink-0 text-success" />}
          <span className={cn("truncate font-medium", allReviewed ? "text-text-secondary" : "text-text-primary")}>{label}</span>
          {!allReviewed && <ChangeCounts added={totals.added} removed={totals.removed} className="shrink-0 font-mono text-[11px]" />}
          {!allReviewed && reviewed.length > 0 && (
            <span className="shrink-0 text-[11px] text-text-subtle @max-[420px]/chat:hidden">· {reviewed.length} reviewed</span>
          )}
        </button>
        {!isMobile && !allReviewed && onSetReviewed && (
          <button
            type="button"
            onClick={markAll}
            // On a narrow chat (`@max-[420px]/chat`) the words go and the icon stays, so the
            // bar's own label — what changed — is the thing that keeps its room.
            aria-label="Mark all reviewed"
            title="Mark all reviewed"
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded px-2 text-xs text-text-secondary transition-colors hover:bg-surface hover:text-text-primary @max-[420px]/chat:px-1.5"
          >
            <ListChecks className="size-3.5" />
            <span className="@max-[420px]/chat:hidden">Mark all reviewed</span>
          </button>
        )}
        {!allReviewed && (
          <button
            type="button"
            onClick={() => review()}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded px-3 text-xs font-medium text-primary transition-colors hover:bg-surface md:min-h-8 md:px-2"
          >
            <FileDiff className="size-3.5" />
            Review
          </button>
        )}
      </div>

      {!isMobile && open && (
        <div
          id={listId}
          className="max-h-56 overflow-y-auto border-t border-border-soft"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {rows(true)}
          <p className="px-2.5 py-1.5 text-[11px] text-text-subtle">{shellChangesHint(providerId)}</p>
        </div>
      )}

      {isMobile && (
        <BottomSheet open={open} onClose={() => setOpen(false)} className="flex max-h-[85%] flex-col">
          <div className="flex items-center gap-2 border-b border-border-soft pb-1 pl-4 pr-1">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">Changed in this chat</span>
            {!allReviewed && <ChangeCounts added={totals.added} removed={totals.removed} className="shrink-0 font-mono text-xs" />}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-text-subtle transition-colors hover:bg-surface hover:text-text-primary"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{rows(false)}</div>
          {/* Thumb zone: the actions that matter sit at the bottom of the sheet. */}
          <div className="shrink-0 space-y-2 border-t border-border-soft px-3 pt-2">
            <p className="text-xs leading-relaxed text-text-subtle">{shellChangesHint(providerId)}</p>
            {!allReviewed && (
              <div className="flex gap-2">
                {onSetReviewed && (
                  <button
                    type="button"
                    onClick={markAll}
                    className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background text-sm font-medium text-text-primary transition-colors hover:bg-surface"
                  >
                    <ListChecks className="size-4" />
                    Mark all reviewed
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => review()}
                  className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <FileDiff className="size-4" />
                  Review all {fileCount(pending.length)}
                </button>
              </div>
            )}
          </div>
        </BottomSheet>
      )}
    </div>
  );
}
