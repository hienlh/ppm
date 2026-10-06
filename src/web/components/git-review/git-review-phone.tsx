/**
 * The Review changes tab on a phone: one block at a time, its two answers
 * under the thumb, and the file list — with the commit box under it — in a
 * sheet. The block carries no buttons of its own here; the bottom bar answers
 * the one in focus.
 */
import { useState, type ReactNode } from "react";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { FileIcon } from "@/lib/file-icons";
import { Check, ChevronLeft, ChevronRight, ExternalLink, List, MoreVertical, Trash2, Undo2, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { changeLetter, discardSummary, splitPath } from "@/lib/git-changes-view";
import { reviewLanguage } from "@/components/session-review/review-tokens";
import { GitCommitComposer } from "@/components/git/git-commit-composer";
import { GitConfirm, type GitConfirmRequest } from "@/components/git/git-confirm";
import { StatusTile } from "@/components/git/git-change-parts";
import { ReviewBlockCard } from "./git-review-block";
import { useBlockActions } from "./git-review-desktop";
import { ReviewEmpty, ReviewFileList, ReviewToastView, plural } from "./git-review-parts";
import type { GitReviewView } from "./git-review-tab";

const iconButton = "inline-grid size-11 shrink-0 place-items-center rounded-[10px] text-text-2 active:bg-surface-hover";
const barButton =
  "inline-flex h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border px-3.5 text-sm font-medium active:opacity-80 disabled:opacity-45";

export function GitReviewPhone({ view }: { view: GitReviewView }) {
  const { review } = view;
  const { focused, totals } = review;
  const [sheet, setSheet] = useState<null | "files" | "actions">(null);
  const [confirm, setConfirm] = useState<GitConfirmRequest | null>(null);
  const actions = useBlockActions(view);
  const close = () => setSheet(null);
  const open = totals.blocks - totals.staged;
  const operation = review.changes?.operation ?? null;
  const block = focused?.block;
  const path = focused?.review.path ?? "";

  const askDiscardFile = () => {
    const file = focused?.review.file;
    if (!file) return;
    const summary = discardSummary([file]);
    setConfirm({
      anchor: null,
      title: summary.title,
      body: summary.body,
      confirmLabel: summary.confirm,
      onConfirm: () => review.discardFile(file.path),
    });
  };

  return (
    <div data-testid="git-review" className="flex h-full flex-col overflow-hidden bg-bg">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border-soft bg-panel pr-1 pl-3.5">
        <h3 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">
          Review changes
          <small className="block truncate text-[11.5px] font-normal text-text-3">
            {totals.blocks ? `${totals.staged} of ${plural(totals.blocks, "block")} staged` : view.branch ?? "Nothing to review"}
          </small>
        </h3>
        <button type="button" className={iconButton} aria-label="Changed files" onClick={() => setSheet("files")}>
          <List className="size-5" />
        </button>
      </div>
      <div className="h-[3px] shrink-0 bg-text/10">
        <div className="h-full bg-primary transition-[width]" style={{ width: totals.blocks ? `${(totals.staged / totals.blocks) * 100}%` : 0 }} />
      </div>

      {review.error && <div className="shrink-0 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{review.error}</div>}

      {focused && block ? (
        <>
          <PhoneFileHeader view={view} onActions={() => setSheet("actions")} />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-auto bg-bg pt-2 pb-3 font-mono text-[11px] leading-[1.65] [tab-size:4]">
              <ReviewBlockCard
                name={splitPath(path)[1]}
                oldPath={focused.review.file?.oldPath}
                block={block}
                index={focused.index}
                total={focused.review.blocks.length}
                focused={block.state === "open"}
                pick={null}
                compact
                lang={reviewLanguage(path)}
                busy={!!review.busy}
                actions={actions}
              />
            </div>
            {review.toast && <ReviewToastView toast={review.toast} mobile onClose={review.dismissToast} />}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-border-soft bg-panel px-2.5 py-2">
            <button type="button" className={cn(barButton, "border-border bg-panel-2 px-0 text-text")} aria-label="Previous block" onClick={() => review.step(-1)}>
              <ChevronLeft className="size-5" />
            </button>
            {block.state === "open" ? (
              <>
                <button type="button" className={cn(barButton, "flex-1 border-border bg-panel-2 text-text")} onClick={() => review.discard(path, block.key)}>
                  <Trash2 className="size-5" />Discard
                </button>
                <button type="button" className={cn(barButton, "flex-1 border-transparent bg-primary text-primary-foreground")} onClick={() => review.stage(path, block.key)}>
                  <Check className="size-5" />Stage
                </button>
              </>
            ) : block.state === "staged" ? (
              <button type="button" className={cn(barButton, "flex-1 border-border bg-panel-2 text-text")} onClick={() => review.unstage(path, block.key)}>
                <Undo2 className="size-5" />Unstage
              </button>
            ) : (
              <button
                type="button"
                className={cn(barButton, "flex-1 border-border bg-panel-2 text-text")}
                disabled={!block.recordId || !!review.busy}
                onClick={() => block.recordId && review.undoDiscard(block.recordId)}
              >
                <Undo2 className="size-5" />Undo discard
              </button>
            )}
            <button type="button" className={cn(barButton, "border-border bg-panel-2 px-0 text-text")} aria-label="Next block" onClick={() => review.step(1)}>
              <ChevronRight className="size-5" />
            </button>
          </div>
        </>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ReviewEmpty conflicts={review.conflicts.length} onGraph={view.openGraph} />
          {review.toast && <ReviewToastView toast={review.toast} mobile onClose={review.dismissToast} />}
        </div>
      )}

      <BottomSheet open={sheet === "files"} onClose={close} className="flex max-h-[85%] flex-col">
        <SheetHead
          title={`Changes · ${view.branch ?? "detached HEAD"}`}
          sub={totals.blocks ? `${totals.staged} of ${plural(totals.blocks, "block")} staged · ${open ? `${open} to decide` : "all decided"}` : undefined}
          onClose={close}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ReviewFileList
            reviews={review.reviews}
            conflicts={review.conflicts}
            current={focused?.review.path ?? null}
            mobile
            onPick={(p) => { review.focusFile(p); close(); }}
            onResolve={(file) => { close(); view.resolve(file); }}
          />
        </div>
        {review.changes && totals.files > 0 && !operation && (
          <GitCommitComposer
            projectName={view.projectName}
            branch={view.branch}
            totals={review.commitTotals}
            lastCommit={review.changes.lastCommit}
            busy={review.busy}
            onCommit={async (message, options) => {
              const done = await review.commit(message, options);
              if (done) close();
              return done;
            }}
            onUndoCommit={review.undoCommit}
            className="shrink-0 border-t border-border-soft"
          />
        )}
      </BottomSheet>

      {focused && (
        <BottomSheet open={sheet === "actions"} onClose={close} className="flex max-h-[85%] flex-col">
          <SheetHead title={splitPath(path)[1]} onClose={close} />
          <div className="border-t border-border-soft py-1">
            {focused.review.file && focused.review.file.y !== "D" && (
              <ActionRow icon={<ExternalLink className="size-5" />} label="Open file" onClick={() => { close(); view.openFile(path); }} />
            )}
            {focused.review.open > 0 && (
              <>
                <ActionRow icon={<Check className="size-5" />} label="Stage file" onClick={() => { close(); review.stageFile(path); }} />
                <ActionRow icon={<Trash2 className="size-5" />} label="Discard file…" destructive onClick={() => { close(); askDiscardFile(); }} />
              </>
            )}
          </div>
        </BottomSheet>
      )}
      <GitConfirm request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function SheetHead({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 pt-0.5 pr-1.5 pb-2 pl-4">
      <div className="min-w-0 flex-1">
        <h4 className="m-0 min-w-0 truncate text-[15px] font-semibold">{title}</h4>
        {sub && <p className="m-0 mt-0.5 text-xs text-text-3">{sub}</p>}
      </div>
      <button type="button" className={iconButton} aria-label="Close" onClick={onClose}>
        <X className="size-5" />
      </button>
    </div>
  );
}

function PhoneFileHeader({ view, onActions }: { view: GitReviewView; onActions: () => void }) {
  const { review, index } = view.review.focused!;
  const [dir, name] = splitPath(review.path);
  const deleted = review.file?.x === "D" || review.file?.y === "D";
  return (
    <div className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-border-soft bg-panel py-1 pr-1 pl-3.5">
      <FileIcon name={name} className="size-4" />
      <span className="flex min-w-0 flex-1 flex-col">
        <b className={cn("truncate text-sm font-semibold", deleted && "text-text-2 line-through")}>{name}</b>
        <small className="truncate text-[11.5px] text-text-3">
          {[`Block ${index + 1} of ${review.blocks.length}`, dir].filter(Boolean).join(" · ")}
        </small>
      </span>
      {review.file && <StatusTile letter={changeLetter(review.file)} />}
      <button type="button" className={iconButton} aria-label="File actions" onClick={onActions}>
        <MoreVertical className="size-5" />
      </button>
    </div>
  );
}

function ActionRow({ icon, label, destructive, onClick }: { icon: ReactNode; label: string; destructive?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm active:bg-surface-hover", destructive ? "text-error" : "text-text")}
    >
      {icon}{label}
    </button>
  );
}
