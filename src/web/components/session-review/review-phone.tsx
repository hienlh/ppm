/**
 * The Review tab on a phone: one block at a time, its two answers under the thumb, the file list
 * in a sheet. The blocks carry no buttons of their own here; the bottom bar answers the one in
 * focus, and a decided one is opened again from the same place.
 */
import { useState, type ReactNode } from "react";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { FileIcon } from "@/lib/file-icons";
import { Check, ChevronLeft, ChevronRight, ExternalLink, FolderTree, ListChecks, MessageCircle, MoreVertical, RotateCcw, Undo2, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { PaneBody, type ReviewView } from "./review-view";
import { ReviewEmpty, ReviewFileList, ToastView, nameAndDir, revertFileText } from "./review-parts";

const iconButton = "inline-grid size-11 shrink-0 place-items-center rounded-[10px] text-text-2 active:bg-surface-hover";
const barButton = "inline-flex h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border px-3 text-sm font-medium active:opacity-80 disabled:opacity-50";

type Sheet = null | "files" | "actions" | "confirm";

export function ReviewPhone({ view }: { view: ReviewView }) {
  const { review, projectPath } = view;
  const { focused, focus, progress, reviews } = review;
  const [sheet, setSheet] = useState<Sheet>(null);
  const close = () => setSheet(null);
  const decided = progress.total - progress.open;

  return (
    <div data-testid="session-review" className="flex h-full flex-col overflow-hidden bg-bg">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border-soft bg-panel pr-1 pl-3.5">
        <h3 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold">Review changes</h3>
        {progress.total > 0 && (
          <span className="mr-0.5 text-xs text-text-2"><b className="font-semibold text-text">{decided}</b>/{progress.total} blocks</span>
        )}
        <button type="button" className={iconButton} aria-label="All files" onClick={() => setSheet("files")}>
          <FolderTree className="size-5" />
        </button>
      </div>
      <div className="h-[3px] shrink-0 bg-[color-mix(in_srgb,var(--text)_10%,transparent)]">
        <div className="h-full bg-primary transition-[width]" style={{ width: progress.total ? `${(decided / progress.total) * 100}%` : 0 }} />
      </div>

      {review.error && <div className="shrink-0 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{review.error}</div>}

      {focused ? (
        <>
          <PhoneFileHeader view={view} onActions={() => setSheet("actions")} />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <PaneBody view={view} compact onRevertFile={() => setSheet("confirm")} />
            {review.toast && <ToastView toast={review.toast} mobile onUndo={() => review.toast?.undoId && void review.undo(review.toast.undoId, review.toast.focus)} />}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-border-soft bg-panel px-2.5 py-2">
            <button type="button" className={cn(barButton, "border-border bg-panel-2 px-0 text-text")} aria-label="Previous block" onClick={() => review.step(-1)}>
              <ChevronLeft className="size-5" />
            </button>
            {view.focusState === "open" ? (
              <>
                <button type="button" className={cn(barButton, "flex-1 border-border bg-panel-2 text-text")} onClick={() => view.revertFocused(() => setSheet("confirm"))}>
                  <RotateCcw className="size-5" />Revert
                </button>
                <button type="button" className={cn(barButton, "flex-1 border-transparent bg-primary text-primary-foreground")} onClick={view.keepFocused}>
                  <Check className="size-5" />Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                className={cn(barButton, "flex-1 border-border bg-panel-2 text-text")}
                disabled={!view.changeFocused}
                onClick={() => view.changeFocused?.()}
              >
                <Undo2 className="size-5" />Change
              </button>
            )}
            <button type="button" className={cn(barButton, "border-border bg-panel-2 px-0 text-text")} aria-label="Next block" onClick={() => review.step(1)}>
              <ChevronRight className="size-5" />
            </button>
          </div>
        </>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ReviewEmpty
            loading={review.files === null || (progress.open > 0 && !focus)}
            files={reviews.length}
            total={progress.total}
            kept={progress.kept}
            onChat={view.openChat}
          />
          {review.toast && <ToastView toast={review.toast} mobile onUndo={() => review.toast?.undoId && void review.undo(review.toast.undoId, review.toast.focus)} />}
        </div>
      )}

      <BottomSheet open={sheet === "files"} onClose={close} className="flex max-h-[85%] flex-col">
        <SheetHead title="Files changed in this chat" sub={`${decided} of ${progress.total} blocks decided · ${progress.open} left`} onClose={close} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ReviewFileList
            reviews={reviews}
            current={focused?.path ?? null}
            mobile
            projectPath={projectPath}
            onPick={(path) => { review.focusFile(path); close(); }}
          />
        </div>
        {progress.open > 0 && (
          <div className="flex shrink-0 gap-2 border-t border-border-soft px-4 pt-2.5">
            <button type="button" className={cn(barButton, "flex-1 border-border bg-panel-2 text-text")} onClick={() => { close(); void review.keepAll(); }}>
              <ListChecks className="size-5" />Keep all remaining
            </button>
          </div>
        )}
      </BottomSheet>

      {focused && (
        <BottomSheet open={sheet === "actions" || sheet === "confirm"} onClose={close} className="flex max-h-[85%] flex-col">
          {sheet === "confirm" ? <ConfirmRevert view={view} onDone={close} /> : <FileActions view={view} onClose={close} onRevert={() => setSheet("confirm")} />}
        </BottomSheet>
      )}
    </div>
  );
}

function SheetHead({ title, sub, icon, onClose }: { title: string; sub?: string; icon?: ReactNode; onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 pt-0.5 pr-1.5 pb-2 pl-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {icon}
          <h4 className="m-0 min-w-0 truncate text-[15px] font-semibold">{title}</h4>
        </div>
        {sub && <p className="m-0 mt-0.5 text-xs text-text-subtle">{sub}</p>}
      </div>
      <button type="button" className={iconButton} aria-label="Close" onClick={onClose}>
        <X className="size-5" />
      </button>
    </div>
  );
}

function PhoneFileHeader({ view, onActions }: { view: ReviewView; onActions: () => void }) {
  const r = view.review.focused!;
  const { base, dir } = nameAndDir(r.path, view.projectPath);
  const where = view.review.pane.kind === "whole" ? "Whole file" : view.place ? `Block ${view.place.index + 1} of ${view.place.total}` : "";
  return (
    <div className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-border-soft bg-panel py-1 pr-1 pl-3.5">
      <FileIcon name={base} className="size-4" />
      <span className="flex min-w-0 flex-1 flex-col">
        <b className={cn("truncate text-sm font-semibold", r.file.status === "deleted" && "text-text-2 line-through")}>{base}</b>
        <small className="truncate text-[11.5px] text-text-subtle">{[where, dir].filter(Boolean).join(" · ")}</small>
      </span>
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

function FileActions({ view, onClose, onRevert }: { view: ReviewView; onClose: () => void; onRevert: () => void }) {
  const r = view.review.focused!;
  const { base } = nameAndDir(r.path, view.projectPath);
  const deleted = r.file.status === "deleted";
  const run = (fn: () => void) => () => { onClose(); fn(); };
  return (
    <>
      <SheetHead title={base} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border-soft py-1">
        {!deleted && !r.gone && <ActionRow icon={<ExternalLink className="size-5" />} label="Open file" onClick={run(() => view.openFile(r.path))} />}
        {r.open > 0 && !r.gone && <ActionRow icon={<Check className="size-5" />} label="Keep file" onClick={run(() => void view.review.keepFile())} />}
        {!r.gone && <ActionRow icon={<RotateCcw className="size-5" />} label="Revert file…" destructive onClick={onRevert} />}
        <ActionRow icon={<MessageCircle className="size-5" />} label="Back to chat" onClick={run(view.openChat)} />
      </div>
    </>
  );
}

function ConfirmRevert({ view, onDone }: { view: ReviewView; onDone: () => void }) {
  const r = view.review.focused!;
  const { base } = nameAndDir(r.path, view.projectPath);
  return (
    <>
      <SheetHead title={`Revert ${base}?`} icon={<RotateCcw className="size-5 shrink-0 text-error" />} onClose={onDone} />
      <div className="px-4 pb-1">
        <p className="m-0 mb-3.5 text-sm leading-normal text-text-2">{revertFileText(r.file, base, r.blocks.length)}</p>
        <div className="flex gap-2">
          <button type="button" className={cn(barButton, "flex-1 border-border bg-panel-2 text-text")} onClick={onDone}>Cancel</button>
          <button
            type="button"
            className={cn(barButton, "flex-1 border-transparent bg-[color-mix(in_srgb,var(--error)_85%,#000)] text-white")}
            onClick={() => { onDone(); void view.review.revertFile(); }}
          >
            <RotateCcw className="size-5" />Revert file
          </button>
        </div>
      </div>
    </>
  );
}
