/**
 * Every file this chat session has changed, as one chip in the footer's context row:
 * "N files +X −Y". It opens a popover — a bottom sheet on a phone — holding the list, a refresh,
 * "Mark all reviewed" and the primary Review button for the multi-file diff tab. Cumulative
 * across turns, where the chip under each answer covers that turn only.
 *
 * A file marked reviewed leaves the list and the totals until the agent changes it again,
 * behind one "N reviewed" row that brings them back; with every file reviewed the chip says so.
 *
 * What the list cannot see is said in the list. Claude's shell commands are followed through
 * git, so a file outside a repository or ignored by one took no "before" copy; another
 * agent's shell commands are not followed at all. Those files are only in Source Control.
 */
import { useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useProjectStore } from "@/stores/project-store";
import { CheckCircle2, Eye, EyeOff, FilePen, ListChecks, RefreshCw } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { fileCount, sessionChangeTotals, splitReviewed } from "@/lib/session-file-changes";
import { ChangeCounts } from "./change-file-row";
import { SessionChangeRow } from "./session-change-row";
import { FooterButton, FooterPopover, FooterPopoverFooter, FooterPopoverHeader } from "./footer-popover";
import { FOOTER_CHIP, HIDE_NARROW } from "./footer-chip";
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

export function SessionChangesChip({ files, loaded = true, loading = false, unloadedCount = 0, projectName, providerId, onReview, onOpen, onRefresh, onSetReviewed }: {
  files: SessionFileChange[];
  /**
   * Whether `files` is the server's answer. The list is worked out only when opened, so until
   * then the chip counts the `unloadedCount` files the transcript names, with no line totals.
   */
  loaded?: boolean;
  loading?: boolean;
  unloadedCount?: number;
  projectName: string;
  providerId?: string;
  /** Open the Review tab, on `path` when one was picked. */
  onReview: (path?: string) => void;
  /** The list was opened: worth asking the server again, the disk may have moved. */
  onOpen?: () => void;
  /** Ask the server again on demand: the list never refreshes on its own. */
  onRefresh?: () => void;
  /** Mark files reviewed (hidden until they change again), or bring them back. */
  onSetReviewed?: (files: SessionFileChange[], reviewed: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showReviewed, setShowReviewed] = useState(false);
  const isMobile = useIsMobile();
  const chipRef = useRef<HTMLButtonElement>(null);
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.name === projectName)?.path);

  if (loaded ? files.length === 0 && !(loading && open) : unloadedCount === 0) return null;

  const { pending, reviewed } = splitReviewed(files);
  const allReviewed = loaded && files.length > 0 && pending.length === 0;
  // Nothing else to show once every file is reviewed.
  const reviewedShown = showReviewed || allReviewed;
  const totals = sessionChangeTotals(pending);
  const count = !loaded ? unloadedCount : allReviewed ? reviewed.length : pending.length;
  const heading = allReviewed ? `All ${fileCount(count)} reviewed` : `${fileCount(count)} changed`;
  const toggle = () => {
    if (!open) onOpen?.();
    setOpen(!open);
  };
  const review = (path?: string) => {
    setOpen(false);
    // The Review tab follows the agent through this list, so opening it is opening the list.
    if (!loaded) onOpen?.();
    onReview(path);
  };
  const markAll = () => {
    setOpen(false);
    onSetReviewed?.(pending, true);
  };
  const dense = !isMobile;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${heading} — open the list`}
        data-testid="session-changes-chip"
        className={FOOTER_CHIP}
      >
        {allReviewed ? <CheckCircle2 className="text-success" /> : <FilePen />}
        <b className="font-medium tabular-nums text-text">{count}</b>
        <span className={HIDE_NARROW}>{allReviewed ? "reviewed" : count === 1 ? "file" : "files"}</span>
        {loaded && !allReviewed && (
          // The row measures the chat: below 600px the line totals go first, before the labels.
          <ChangeCounts added={totals.added} removed={totals.removed} className={cn("font-mono text-[11px] @max-[600px]/chat:hidden", HIDE_NARROW)} />
        )}
      </button>

      <FooterPopover open={open} onClose={() => setOpen(false)} label="Changed in this chat" anchorRef={chipRef}>
        <FooterPopoverHeader>
          <FilePen className="size-3.5 shrink-0 text-text-3" />
          <b className="truncate text-[13px] font-semibold max-md:text-sm">{heading}</b>
          {loaded && !allReviewed && <ChangeCounts added={totals.added} removed={totals.removed} className="shrink-0 font-mono text-[11px] max-md:text-xs" />}
          {!allReviewed && reviewed.length > 0 && (
            <span className="ml-auto shrink-0 text-[11px] text-text-3">{reviewed.length} reviewed</span>
          )}
        </FooterPopoverHeader>
        <div className="max-h-56 min-h-0 overflow-y-auto overscroll-contain max-md:max-h-none max-md:flex-1">
          {loading && files.length === 0 && (
            <p className={cn("text-text-subtle", dense ? "px-2.5 py-1.5 text-[11px]" : "px-4 py-3 text-xs")}>Working out what changed…</p>
          )}
          {pending.map((file) => (
            <SessionChangeRow
              key={file.path}
              file={file}
              projectPath={projectPath}
              dense={dense}
              onClick={() => review(file.path)}
              onToggleReviewed={onSetReviewed ? () => onSetReviewed([file], !file.reviewed) : undefined}
            />
          ))}
          {reviewed.length > 0 && !allReviewed && (
            <ReviewedToggle count={reviewed.length} shown={showReviewed} dense={dense} onToggle={() => setShowReviewed(!showReviewed)} />
          )}
          {reviewedShown && reviewed.map((file) => (
            <SessionChangeRow
              key={file.path}
              file={file}
              projectPath={projectPath}
              dense={dense}
              onClick={() => review(file.path)}
              onToggleReviewed={onSetReviewed ? () => onSetReviewed([file], !file.reviewed) : undefined}
            />
          ))}
          <p className="px-2.5 py-1.5 text-[11px] leading-relaxed text-text-subtle max-md:px-4 max-md:text-xs">{shellChangesHint(providerId)}</p>
        </div>
        {/* Thumb zone on a phone: the actions that matter sit at the bottom of the sheet. */}
        <FooterPopoverFooter>
          {onRefresh && (
            <FooterButton
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh changes"
              title="Refresh changes"
              data-testid="session-changes-refresh"
              className="max-md:w-11 max-md:justify-center max-md:px-0"
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
            </FooterButton>
          )}
          {loaded && !allReviewed && onSetReviewed && (
            <FooterButton onClick={markAll}>
              <ListChecks />
              Mark all reviewed
            </FooterButton>
          )}
          {!allReviewed && (
            <FooterButton variant="primary" onClick={() => review()}>
              <FilePen />
              Review
            </FooterButton>
          )}
        </FooterPopoverFooter>
      </FooterPopover>
    </>
  );
}
