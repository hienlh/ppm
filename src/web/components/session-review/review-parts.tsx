/**
 * The pieces the Review tab's desktop and phone layouts share: the file list with a dot per
 * block, the progress strip, the status letter, the toast, and the words a revert is confirmed in.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FileIcon } from "@/lib/file-icons";
import { CheckCircle2, Loader2, MessageCircle } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { displayPath, splitDisplayPath } from "@/lib/session-file-changes";
import { fileOutcome, type FileReview } from "@/lib/session-review-model";
import type { ReviewToast } from "@/hooks/use-session-review";
import type { SessionChangeStatus, SessionFileChange } from "../../../shared/session-file-changes";

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function nameAndDir(path: string, projectPath: string | undefined): { base: string; dir: string } {
  return splitDisplayPath(displayPath(path, projectPath));
}

const STATUS: Record<SessionChangeStatus, { glyph: string; cls: string; label: string }> = {
  added: { glyph: "A", cls: "text-success bg-[color-mix(in_srgb,var(--success)_14%,transparent)]", label: "Added" },
  modified: { glyph: "M", cls: "text-warning bg-[color-mix(in_srgb,var(--warning)_14%,transparent)]", label: "Modified" },
  deleted: { glyph: "D", cls: "text-error bg-[color-mix(in_srgb,var(--error)_14%,transparent)]", label: "Deleted" },
};

export function StatusLetter({ status }: { status: SessionChangeStatus }) {
  const s = STATUS[status];
  return (
    <span title={s.label} aria-label={s.label} className={cn("inline-grid size-[18px] shrink-0 place-items-center rounded-[5px] font-mono text-[10.5px] font-semibold leading-none", s.cls)}>
      {s.glyph}
    </span>
  );
}

function Tag({ tint, children }: { tint: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded px-[5px] text-[10px] font-semibold leading-[15px]"
      style={{ color: tint, background: `color-mix(in srgb, ${tint} 14%, transparent)` }}
    >
      {children}
    </span>
  );
}

/** Dots shown before the rest is counted: a file with more blocks says so in its `k/n`. */
const MAX_DOTS = 10;

function FileRow({ review, current, mobile, projectPath, onPick }: {
  review: FileReview;
  current: boolean;
  mobile: boolean;
  projectPath: string | undefined;
  onPick: (path: string) => void;
}) {
  const { base, dir } = nameAndDir(review.path, projectPath);
  const file = review.file;
  const done = review.open === 0;
  const outcome = done ? fileOutcome(review) : null;
  const decided = review.blocks.length - review.open;
  return (
    <button
      type="button"
      title={review.path}
      aria-current={current ? "true" : undefined}
      data-testid="review-file-row"
      onClick={() => onPick(review.path)}
      className={cn(
        "grid w-full items-center text-left text-text transition-colors hover:bg-surface-hover",
        mobile ? "min-h-14 grid-cols-[18px_minmax(0,1fr)_auto] gap-3 px-4 py-1.5" : "min-h-[42px] grid-cols-[16px_minmax(0,1fr)_auto] gap-[9px] px-3 py-1",
        current && "bg-accent-wash shadow-[inset_2px_0_0_var(--accent)] hover:bg-accent-wash",
      )}
    >
      <FileIcon name={base} className={mobile ? "size-[18px]" : "size-4"} />
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "truncate",
            mobile ? "text-sm leading-[19px]" : "text-[13px] leading-[17px]",
            done ? "font-normal text-text-2" : "font-medium",
            file.status === "deleted" && "line-through",
          )}
        >
          {base}
        </span>
        <span className={cn("flex min-w-0 items-center gap-1.5 text-text-subtle", mobile ? "text-xs" : "text-[11px] leading-[15px]")}>
          {file.sinceReview ? <Tag tint="var(--accent-2)">New since review</Tag> : file.baseline === "head" && <Tag tint="var(--warning)">vs last commit</Tag>}
          {dir && <span dir="rtl" className="min-w-0 flex-1 truncate text-left"><bdi>{dir}</bdi></span>}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <span className="flex gap-[3px]" aria-hidden>
          {review.blocks.slice(0, MAX_DOTS).map((b) => (
            <i
              key={b.key}
              className={cn(
                "rounded-full border-[1.5px]",
                mobile ? "size-2.5" : "size-2",
                b.state === "kept" ? "border-primary bg-primary" : b.state === "reverted" ? "border-error bg-error" : "border-[color-mix(in_srgb,var(--text-3)_80%,transparent)]",
              )}
            />
          ))}
        </span>
        {outcome ? (
          <span
            className={cn(
              "whitespace-nowrap text-[10.5px] font-semibold",
              outcome.tone === "kept" ? "text-primary" : outcome.tone === "reverted" ? "text-error" : "font-medium text-text-subtle",
            )}
          >
            {outcome.label}
          </span>
        ) : (
          <span className="font-mono text-[10.5px] font-medium leading-none text-text-subtle">{decided}/{review.blocks.length}</span>
        )}
      </span>
    </button>
  );
}

function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex h-8 w-full shrink-0 items-center gap-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[.07em] text-text-subtle">
      {label}
      <span className="rounded-full bg-surface-hover px-1.5 py-px font-mono text-[10.5px] font-medium leading-[14px] tracking-normal text-text-2">{count}</span>
    </div>
  );
}

/** Files with a block left first, then the finished ones with how they ended. */
export function ReviewFileList({ reviews, current, mobile, projectPath, onPick }: {
  reviews: FileReview[];
  current: string | null;
  mobile: boolean;
  projectPath: string | undefined;
  onPick: (path: string) => void;
}) {
  const pending = reviews.filter((r) => r.open > 0);
  const done = reviews.filter((r) => r.open === 0);
  const row = (r: FileReview) => (
    <FileRow key={r.path} review={r} current={r.path === current} mobile={mobile} projectPath={projectPath} onPick={onPick} />
  );
  return (
    <>
      <SectionHead label="To review" count={pending.length} />
      {pending.length ? pending.map(row) : <p className="m-0 px-3 pb-2 text-xs text-text-subtle">Nothing left open.</p>}
      {done.length > 0 && (
        <>
          <SectionHead label="Done" count={done.length} />
          {done.map(row)}
        </>
      )}
    </>
  );
}

/** Segments are drawn one per block up to this many; past it, one bar in proportion. */
const MAX_SEGMENTS = 48;

/** One segment per block — kept, reverted or still open — and how many are left. */
export function ReviewProgress({ reviews, total, open, projectPath }: {
  reviews: FileReview[];
  total: number;
  open: number;
  projectPath: string | undefined;
}) {
  const blocks = reviews.flatMap((r) => r.blocks.map((b, i) => ({ id: `${r.path}\0${b.key}`, state: b.state, title: `${nameAndDir(r.path, projectPath).base} · block ${i + 1}` })));
  const kept = blocks.filter((b) => b.state === "kept").length;
  const reverted = blocks.filter((b) => b.state === "reverted").length;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 whitespace-nowrap text-[12.5px] text-text-2">
      <span role="progressbar" aria-label="Blocks decided" aria-valuemin={0} aria-valuemax={total} aria-valuenow={total - open} className="flex gap-0.5">
        {total <= MAX_SEGMENTS ? blocks.map((b) => (
          <i
            key={b.id}
            title={b.title}
            className={cn(
              "h-1.5 w-3 rounded-[3px] transition-colors",
              b.state === "kept" ? "bg-primary" : b.state === "reverted" ? "bg-[color-mix(in_srgb,var(--error)_70%,transparent)]" : "bg-[color-mix(in_srgb,var(--text)_13%,transparent)]",
            )}
          />
        )) : (
          <span className="flex h-1.5 w-40 overflow-hidden rounded-[3px] bg-[color-mix(in_srgb,var(--text)_13%,transparent)]">
            <i className="bg-primary" style={{ width: `${(kept / total) * 100}%` }} />
            <i className="bg-[color-mix(in_srgb,var(--error)_70%,transparent)]" style={{ width: `${(reverted / total) * 100}%` }} />
          </span>
        )}
      </span>
      <span><b className="font-semibold text-text">{total - open}</b> of {plural(total, "block")} decided</span>
      {open ? <span className="text-text-subtle">· {open} left</span> : <span className="text-success">· all done</span>}
    </div>
  );
}

/** What reverting a whole file does, in a sentence. */
export function revertFileText(file: SessionFileChange, base: string, blocks: number): ReactNode {
  const name = <b className="font-semibold text-text">{base}</b>;
  const counts = file.additions != null && file.deletions != null ? <span className="font-mono text-[11px]"><span className="text-success">+{file.additions}</span> <span className="text-error">−{file.deletions}</span></span> : null;
  if (file.status === "added") return <>Deletes {name} — it did not exist before this chat. You can undo it right after.</>;
  if (file.status === "deleted") return <>Brings {name} back{file.deletions ? ` with its ${plural(file.deletions, "line")}` : ""}. You can undo it right after.</>;
  const where = file.sinceReview
    ? <>Puts {name} back to the version you reviewed</>
    : file.baseline === "head" ? <>Puts {name} back to its last committed version</> : <>Puts {name} back the way it was before this chat</>;
  return <>{where}{blocks > 1 ? <>, all {plural(blocks, "block")}</> : null}{counts ? <> — {counts} undone on disk</> : null}. You can undo it right after.</>;
}

export function ToastView({ toast, mobile, onUndo }: { toast: ReviewToast; mobile: boolean; onUndo: () => void }) {
  return (
    <div
      role="status"
      data-testid="review-toast"
      className={cn(
        "absolute z-30 flex items-center border border-border bg-panel-2 shadow-[var(--shadow-float)]",
        mobile
          ? "inset-x-3 bottom-3 gap-2.5 rounded-xl py-1.5 pr-1.5 pl-3.5 text-[13.5px]"
          : "bottom-3 left-1/2 max-w-[calc(100%-24px)] -translate-x-1/2 gap-3 rounded-[10px] py-1.5 pr-1.5 pl-3.5 text-[12.5px]",
      )}
    >
      <span className={cn("min-w-0", mobile ? "flex-1" : "truncate")}>
        {toast.lead}{toast.name && <b className="font-semibold">{toast.name}</b>}{toast.tail}
      </span>
      {toast.undoId && (
        <Button variant="ghost" size={mobile ? "sm" : "xs"} className={cn("text-primary hover:text-primary", mobile && "h-10")} onClick={onUndo}>
          Undo
        </Button>
      )}
    </div>
  );
}

/** Nothing in focus: still loading, nothing changed, or every block decided. */
export function ReviewEmpty({ loading, files, total, kept, onChat }: {
  loading: boolean;
  files: number;
  total: number;
  kept: number;
  onChat: () => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-4 animate-spin text-text-subtle" />
      </div>
    );
  }
  return (
    <div className="grid flex-1 place-items-center p-8 text-center">
      <div>
        {files > 0 && (
          <div className="mx-auto mb-3.5 grid size-[52px] place-items-center rounded-full bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-success">
            <CheckCircle2 className="size-5" />
          </div>
        )}
        <h4 className="m-0 mb-1.5 text-[15px] font-semibold">{files > 0 ? `All ${plural(total, "block")} decided` : "No changes yet"}</h4>
        <p className="mx-auto mb-4 max-w-[38ch] text-[13px] text-text-2">
          {files > 0
            ? `${kept} kept, ${total - kept} reverted. A block comes back here if the agent changes it again.`
            : "This chat has not changed any file."}
        </p>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={onChat}>
          <MessageCircle />Back to chat
        </Button>
      </div>
    </div>
  );
}
