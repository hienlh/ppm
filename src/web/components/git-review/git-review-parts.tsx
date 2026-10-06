/**
 * The pieces the Review changes tab's desktop and phone layouts share: the
 * file list with a dot per block, the progress strip, the toast and the empty
 * state.
 */
import { Button } from "@/components/ui/button";
import { StartEllipsis } from "@/components/ui/start-ellipsis";
import { FileIcon } from "@/lib/file-icons";
import { AlertCircle, CheckCircle2, History, Undo2, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { splitPath } from "@/lib/git-changes-view";
import { railGroup, railOrder, type FileReview, type RailGroup, type ReviewBlock } from "@/lib/git-review-model";
import type { ReviewToast } from "@/hooks/use-git-review";
import type { ChangedFile } from "../../../shared/git-changes";
import { CountChip } from "@/components/git/git-change-parts";

export const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

const MAX_DOTS = 6;

/** One dot per block: hollow while open, filled once staged, struck through once discarded. */
export function ReviewDots({ blocks }: { blocks: readonly ReviewBlock[] }) {
  const staged = blocks.filter((b) => b.state === "staged").length;
  return (
    <span className="inline-flex items-center gap-[3px]" title={`${staged} of ${plural(blocks.filter((b) => b.state !== "discarded").length, "block")} staged`}>
      {blocks.slice(0, MAX_DOTS).map((b) => (
        <i
          key={b.key}
          className={cn(
            "relative size-[7px] rounded-full border-[1.5px]",
            b.state === "staged" ? "border-primary bg-primary" : b.state === "discarded" ? "border-error/70" : "border-text-3/85",
            b.state === "discarded" && "after:absolute after:top-[1.5px] after:-right-px after:-left-px after:h-[1.5px] after:-rotate-45 after:bg-error/80",
          )}
        />
      ))}
      {blocks.length > MAX_DOTS && <span className="font-mono text-[10px] leading-none text-text-3">+{blocks.length - MAX_DOTS}</span>}
    </span>
  );
}

/** Segments up to this many blocks; a proportional bar past it. */
const MAX_SEGMENTS = 40;

export function ReviewProgress({ reviews }: { reviews: readonly FileReview[] }) {
  const blocks = railOrder(reviews).flatMap((r) => r.blocks);
  if (!blocks.length) return null;
  if (blocks.length > MAX_SEGMENTS) {
    const staged = blocks.filter((b) => b.state === "staged").length;
    const gone = blocks.filter((b) => b.state === "discarded").length;
    return (
      <span aria-hidden className="flex h-1.5 w-40 overflow-hidden rounded-[3px] bg-text/13">
        <i className="bg-primary" style={{ width: `${(staged / blocks.length) * 100}%` }} />
        <i className="bg-error/60" style={{ width: `${(gone / blocks.length) * 100}%` }} />
      </span>
    );
  }
  return (
    <span aria-hidden className="inline-flex flex-wrap gap-0.5">
      {blocks.map((b, i) => (
        <i
          key={i}
          className={cn("h-1.5 w-2.5 rounded-[3px]", b.state === "staged" ? "bg-primary" : b.state === "discarded" ? "bg-error/60" : "bg-text/13")}
        />
      ))}
    </span>
  );
}

const GROUP_LABEL: Record<RailGroup, string> = { changes: "Changes", staged: "Staged", discarded: "Discarded" };

function FileRow({ review, current, mobile, onPick }: {
  review: FileReview;
  current: boolean;
  mobile: boolean;
  onPick: (path: string) => void;
}) {
  const [dir, name] = splitPath(review.path);
  const group = railGroup(review);
  const deleted = review.file?.x === "D" || review.file?.y === "D";
  return (
    <button
      type="button"
      title={review.path}
      aria-current={current ? "true" : undefined}
      data-testid="git-review-file"
      onClick={() => onPick(review.path)}
      className={cn(
        "grid w-full items-center text-left text-text transition-colors hover:bg-surface-hover",
        mobile ? "min-h-14 grid-cols-[18px_minmax(0,1fr)_auto] gap-3 px-4 py-1.5" : "min-h-[42px] grid-cols-[16px_minmax(0,1fr)_auto] gap-[9px] px-3 py-1",
        current && "bg-accent-wash shadow-[inset_2px_0_0_var(--accent)] hover:bg-accent-wash",
      )}
    >
      <FileIcon name={name} className={mobile ? "size-[18px]" : "size-4"} />
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "flex min-w-0",
            mobile ? "text-sm leading-[19px]" : "text-[13px] leading-[17px]",
            group === "changes" ? "font-medium" : "text-text-2",
            deleted && "line-through",
          )}
        >
          <StartEllipsis>{name}</StartEllipsis>
        </span>
        {dir && (
          <span className={cn("flex min-w-0 text-text-3", mobile ? "text-xs leading-4" : "text-[11px] leading-[15px]")}>
            <StartEllipsis>{dir}</StartEllipsis>
          </span>
        )}
      </span>
      <span className="flex flex-col items-end gap-1">
        <ReviewDots blocks={review.blocks} />
        {group === "staged" ? (
          <span className="whitespace-nowrap text-[10.5px] font-semibold text-primary">Staged</span>
        ) : group === "discarded" ? (
          <span className="whitespace-nowrap text-[10.5px] font-semibold text-error">Discarded</span>
        ) : (
          <small className="font-mono text-[10.5px] font-medium leading-none text-text-3">{review.open} left</small>
        )}
      </span>
    </button>
  );
}

/** The rail: conflicts first (they open the conflict editor), then Changes, Staged and Discarded. */
export function ReviewFileList({ reviews, conflicts, current, mobile, onPick, onResolve }: {
  reviews: readonly FileReview[];
  conflicts: readonly ChangedFile[];
  current: string | null;
  mobile: boolean;
  onPick: (path: string) => void;
  onResolve: (file: ChangedFile) => void;
}) {
  const head = cn(
    "flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-text-3",
    mobile ? "h-10 px-4" : "h-8 px-3",
  );
  const groups = (["changes", "staged", "discarded"] as const).map((g) => [g, reviews.filter((r) => railGroup(r) === g)] as const);
  return (
    <>
      {conflicts.length > 0 && (
        <>
          <div className={cn(head, "text-error")}><AlertCircle className="size-3.5" />Conflicts<CountChip count={conflicts.length} /></div>
          {conflicts.map((file) => {
            const [dir, name] = splitPath(file.path);
            return (
              <button
                key={file.path}
                type="button"
                title={`Resolve ${file.path}`}
                onClick={() => onResolve(file)}
                className={cn(
                  "grid w-full items-center text-left hover:bg-surface-hover",
                  mobile ? "min-h-14 grid-cols-[18px_minmax(0,1fr)_auto] gap-3 px-4" : "min-h-[42px] grid-cols-[16px_minmax(0,1fr)_auto] gap-[9px] px-3",
                )}
              >
                <FileIcon name={name} className={mobile ? "size-[18px]" : "size-4"} />
                <span className="flex min-w-0 flex-col">
                  <span className={cn("flex min-w-0 font-medium", mobile ? "text-sm" : "text-[13px]")}><StartEllipsis>{name}</StartEllipsis></span>
                  {dir && <span className={cn("flex min-w-0 text-text-3", mobile ? "text-xs" : "text-[11px]")}><StartEllipsis>{dir}</StartEllipsis></span>}
                </span>
                <span className="text-xs font-medium text-primary">Resolve</span>
              </button>
            );
          })}
        </>
      )}
      {groups.map(([g, list]) => list.length > 0 && (
        <div key={g}>
          <div className={head}>{GROUP_LABEL[g]}<CountChip count={list.length} /></div>
          {list.map((r) => (
            <FileRow key={r.path} review={r} current={r.path === current} mobile={mobile} onPick={onPick} />
          ))}
        </div>
      ))}
    </>
  );
}

export function ReviewToastView({ toast, mobile, onClose }: { toast: ReviewToast; mobile: boolean; onClose: () => void }) {
  return (
    <div
      role="status"
      data-testid="git-review-toast"
      className={cn(
        "absolute z-30 flex items-center border border-border bg-panel-2 shadow-[var(--shadow-float)]",
        mobile
          ? "inset-x-3 bottom-3 gap-2 rounded-xl py-1 pr-1 pl-3.5 text-[13.5px]"
          : "bottom-3 left-1/2 max-w-[calc(100%-24px)] -translate-x-1/2 gap-3 rounded-[10px] py-[5px] pr-[5px] pl-3.5 text-[12.5px]",
      )}
    >
      <CheckCircle2 className="size-4 shrink-0 text-primary" />
      <span className={cn("min-w-0", mobile ? "flex-1" : "truncate whitespace-nowrap")}>{toast.text}</span>
      {toast.undo && (
        <Button
          variant="ghost"
          size={mobile ? "sm" : "xs"}
          className={cn("text-primary hover:text-primary", mobile && "h-11")}
          onClick={() => { onClose(); toast.undo?.(); }}
        >
          <Undo2 />Undo
        </Button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className={cn("grid shrink-0 place-items-center rounded-md text-text-3 hover:bg-surface-hover hover:text-text", mobile ? "size-11" : "size-6")}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Nothing to review: the working tree matches the last commit, or only conflicts are left. */
export function ReviewEmpty({ conflicts, onGraph }: { conflicts: number; onGraph: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-8 text-center">
      <div>
        <div className="mx-auto mb-3.5 grid size-[52px] place-items-center rounded-full bg-accent-wash text-primary">
          <CheckCircle2 className="size-5" />
        </div>
        <h4 className="m-0 mb-1.5 text-[15px] font-semibold">
          {conflicts ? `${plural(conflicts, "conflict")} to resolve` : "Nothing left to review"}
        </h4>
        <p className="mx-auto mb-4 max-w-[40ch] text-[13px] text-text-2">
          {conflicts
            ? "A conflicted file has no blocks to review until it is resolved: open it from the list."
            : "The working tree matches the last commit. What you commit here shows up at the top of the Git Graph."}
        </p>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={onGraph}>
          <History />Open Git Graph
        </Button>
      </div>
    </div>
  );
}
