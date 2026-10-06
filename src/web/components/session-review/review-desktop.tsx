/**
 * The Review tab on a desktop: progress across the top, the files on the left with a dot per
 * block, and the file in focus with its blocks, stepped through with J/K and answered with Y/N.
 * Below 760px of its own width the file list folds behind a button: a narrow split is not a phone.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { FileIcon } from "@/lib/file-icons";
import { ArrowRight, Check, ChevronLeft, ChevronRight, ExternalLink, FolderTree, ListChecks, MessageCircle, RefreshCw, RotateCcw, Terminal } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { shellChangesHint } from "@/components/chat/session-changes-bar";
import { SessionChangeCounts } from "@/components/chat/session-change-row";
import { Kbd } from "./review-code";
import { PaneBody, type ReviewView } from "./review-view";
import { ReviewEmpty, ReviewFileList, ReviewProgress, StatusLetter, ToastView, nameAndDir, plural, revertFileText } from "./review-parts";

const toolButton = "inline-grid size-7 shrink-0 place-items-center rounded-md text-text-subtle hover:bg-surface-hover hover:text-text";

export function ReviewDesktop({ view }: { view: ReviewView }) {
  const { review, projectPath } = view;
  const { focused, focus, progress, reviews } = review;
  const root = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  // The keys stay with the tab: when it opens from the chat's bar, whose button is now hidden,
  // and when an answer takes away the button that had focus. Never away from somewhere to type.
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const lost = !active || active === document.body || active.getClientRects().length === 0;
    if (lost && !active?.closest("input, textarea, select, [contenteditable='true']")) root.current?.focus({ preventScroll: true });
  }, [focus?.path, focus?.key, review.pane.kind]);
  useEffect(() => setConfirm(false), [focused?.path]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return;
    const key = e.key.toLowerCase();
    if (key === "j" || key === "k") review.step(key === "j" ? 1 : -1);
    else if (key === "y" && view.focusState === "open") view.keepFocused();
    else if (key === "n" && view.focusState === "open") view.revertFocused(() => setConfirm(true));
    else if (key === "escape" && (confirm || filesOpen)) { setConfirm(false); setFilesOpen(false); }
    else return;
    e.preventDefault();
  };

  const pick = (path: string) => {
    review.focusFile(path);
    setFilesOpen(false);
  };
  const list = (
    <>
      <ReviewFileList reviews={reviews} current={focused?.path ?? null} mobile={false} projectPath={projectPath} onPick={pick} />
      <div className="mt-auto border-t border-border-soft px-3 pt-2.5 pb-3 text-[11.5px] leading-normal text-text-subtle">
        <div className="flex gap-1.5">
          <Terminal className="mt-0.5 size-3 shrink-0" />
          <span>A binary or very large file has no blocks: it is kept or reverted whole. {shellChangesHint(view.providerId)}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
          <span className="inline-flex items-center gap-1"><Kbd>Y</Kbd> keep</span>
          <span className="inline-flex items-center gap-1"><Kbd>N</Kbd> revert</span>
        </div>
      </div>
    </>
  );

  return (
    <div
      ref={root}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="session-review"
      className="@container flex h-full flex-col overflow-hidden bg-bg outline-none"
    >
      <div className="relative flex shrink-0 flex-wrap items-center gap-x-[18px] gap-y-2 border-b border-border-soft bg-panel py-2.5 pr-3 pl-4">
        <div className="min-w-0">
          <h3 className="m-0 text-sm font-semibold leading-5">Review changes</h3>
          <button
            type="button"
            title="Back to the chat"
            onClick={view.openChat}
            className="inline-flex max-w-full items-center gap-1 text-xs text-text-2 underline-offset-[3px] hover:text-text hover:underline"
          >
            <MessageCircle className="size-3 shrink-0" />
            <span className="truncate">{view.chatTitle || "Chat"}</span>
          </button>
        </div>
        {progress.total > 0 && <ReviewProgress reviews={reviews} total={progress.total} open={progress.open} projectPath={projectPath} />}
        <span className="flex-1" />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-text-secondary @min-[760px]:hidden"
            aria-expanded={filesOpen}
            onClick={() => setFilesOpen(!filesOpen)}
          >
            <FolderTree />{plural(reviews.length, "file")}
          </Button>
          {progress.open > 0 && (
            <Button variant="ghost" size="sm" className="text-text-secondary" onClick={() => void review.keepAll()}>
              <ListChecks />Keep all remaining
            </Button>
          )}
          <button type="button" className={toolButton} title="Reload" aria-label="Reload" onClick={() => void review.reload()}>
            <RefreshCw className={cn("size-3.5", review.loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {review.error && <div className="shrink-0 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{review.error}</div>}

      <div className="relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] @min-[760px]:grid-cols-[288px_minmax(0,1fr)]">
        <aside aria-label="Changed files" className="hidden min-h-0 flex-col overflow-y-auto border-r border-border-soft bg-panel @min-[760px]:flex">
          {list}
        </aside>
        {filesOpen && (
          <>
            <div className="absolute inset-0 z-20 bg-black/30 @min-[760px]:hidden" onClick={() => setFilesOpen(false)} />
            <aside
              aria-label="Changed files"
              className="absolute inset-y-0 left-0 z-30 flex w-[min(288px,85%)] flex-col overflow-y-auto border-r border-border bg-panel shadow-[var(--shadow-float)] @min-[760px]:hidden"
            >
              {list}
            </aside>
          </>
        )}

        <section aria-label="Changes" className="relative flex min-h-0 min-w-0 flex-col">
          {focused ? (
            <>
              <FileHeader view={view} />
              <div className="relative flex min-h-0 flex-1 flex-col">
                <PaneBody view={view} compact={false} onRevertFile={() => setConfirm(true)} />
                {review.toast && <ToastView toast={review.toast} mobile={false} onUndo={() => review.toast?.undoId && void review.undo(review.toast.undoId, review.toast.focus)} />}
              </div>
              <BottomBar view={view} confirm={confirm} setConfirm={setConfirm} />
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
              {review.toast && <ToastView toast={review.toast} mobile={false} onUndo={() => review.toast?.undoId && void review.undo(review.toast.undoId, review.toast.focus)} />}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function FileHeader({ view }: { view: ReviewView }) {
  const r = view.review.focused!;
  const { base, dir } = nameAndDir(r.path, view.projectPath);
  const deleted = r.file.status === "deleted";
  return (
    <div className="relative flex min-h-12 shrink-0 flex-wrap items-center gap-x-[9px] gap-y-1.5 border-b border-border-soft py-2 pr-3 pl-4">
      <FileIcon name={base} className="size-4" />
      <span className={cn("whitespace-nowrap text-sm font-semibold", deleted && "text-text-2 line-through")}>{base}</span>
      <StatusLetter status={r.file.status} />
      {dir && (
        <span dir="rtl" title={r.path} className="min-w-10 shrink truncate text-left text-xs text-text-subtle">
          <bdi>{dir}/</bdi>
        </span>
      )}
      <SessionChangeCounts file={r.file} className="font-mono text-[11px]" />
      <span className="flex-1" />
      {!deleted && !r.gone && (
        <Button variant="ghost" size="sm" className="text-text-secondary" onClick={() => view.openFile(r.path)}>
          <ExternalLink />Open
        </Button>
      )}
    </div>
  );
}

function BottomBar({ view, confirm, setConfirm }: { view: ReviewView; confirm: boolean; setConfirm: (open: boolean) => void }) {
  const { review } = view;
  const r = review.focused!;
  const { base } = nameAndDir(r.path, view.projectPath);
  const popover = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!confirm) return;
    const onDown = (e: MouseEvent) => { if (!popover.current?.contains(e.target as Node)) setConfirm(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [confirm, setConfirm]);

  const next = view.nextFile;
  return (
    <div className="relative flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-border-soft bg-panel px-3 py-2 text-[12.5px] text-text-2">
      <div className="inline-flex items-center gap-0.5 rounded-lg bg-[color-mix(in_srgb,var(--text)_6%,transparent)] p-0.5">
        <button type="button" className={toolButton} title="Previous block (K)" aria-label="Previous block" onClick={() => review.step(-1)}>
          <ChevronLeft className="size-3.5" />
        </button>
        <span className="min-w-[92px] text-center text-xs font-medium text-text-2">
          {review.pane.kind === "whole" ? "Whole file" : view.place ? `Block ${view.place.index + 1} of ${view.place.total}` : ""}
        </span>
        <button type="button" className={toolButton} title="Next block (J)" aria-label="Next block" onClick={() => review.step(1)}>
          <ChevronRight className="size-3.5" />
        </button>
      </div>
      <span className="min-w-0 truncate">
        {r.open ? <><b className="font-semibold text-text">{r.open}</b> open in {base}</> : <><b className="font-semibold text-text">{base}</b> is done</>}
      </span>
      <span className="flex-1" />
      {!r.gone && (
        <span ref={popover} className="relative">
          <Button variant="ghost" size="sm" className="text-text-secondary" aria-expanded={confirm} onClick={() => setConfirm(!confirm)}>
            <RotateCcw />Revert file…
          </Button>
          {confirm && (
            <div
              role="dialog"
              aria-label={`Revert ${base}?`}
              className="absolute right-0 bottom-[calc(100%+8px)] z-40 w-[330px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-panel-2 p-3.5 text-[12.5px] leading-normal text-text-2 shadow-[var(--shadow-float)]"
            >
              <h5 className="m-0 mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-text">
                <RotateCcw className="size-3.5" />Revert {base}?
              </h5>
              <p className="m-0 mb-3">{revertFileText(r.file, base, r.blocks.length)}</p>
              <div className="flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
                <Button variant="destructive" size="sm" onClick={() => { setConfirm(false); void review.revertFile(); }}>
                  <RotateCcw />Revert file
                </Button>
              </div>
            </div>
          )}
        </span>
      )}
      {r.open > 0 && !r.gone && (
        <Button variant="outline" size="sm" onClick={() => void review.keepFile()}>
          <Check />Keep file
        </Button>
      )}
      {next && (
        <Button
          variant={r.open ? "ghost" : "default"}
          size="sm"
          className={cn(r.open > 0 && "text-text-secondary")}
          onClick={() => review.focusFile(next.path)}
        >
          Next: {nameAndDir(next.path, view.projectPath).base}<ArrowRight />
        </Button>
      )}
    </div>
  );
}
