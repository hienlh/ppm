/**
 * The Review changes tab on a desktop: the branch and the progress across the
 * top, the changed files on the left with the shared commit box under them,
 * and the file in focus with its blocks — stepped through with J/K and
 * answered with Y (stage) and N (discard), or line by line after L.
 *
 * Below 760px of its own width the file list folds behind a button: a narrow
 * split is not a phone.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { FileIcon } from "@/lib/file-icons";
import { ArrowRight, Check, ChevronDown, ChevronUp, ExternalLink, FolderTree, GitBranch, Keyboard, Trash2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { changeLetter, discardSummary, splitPath } from "@/lib/git-changes-view";
import { reviewLanguage } from "@/components/session-review/review-tokens";
import { Kbd } from "@/components/session-review/review-code";
import { GitCommitComposer } from "@/components/git/git-commit-composer";
import { GitConfirm, type GitConfirmRequest } from "@/components/git/git-confirm";
import { LineCounts, StatusTile } from "@/components/git/git-change-parts";
import { ReviewBlockCard, ReviewGap, type BlockActions } from "./git-review-block";
import { ReviewEmpty, ReviewFileList, ReviewProgress, ReviewToastView, plural } from "./git-review-parts";
import type { GitReviewView } from "./git-review-tab";

const toolButton = "inline-grid size-7 shrink-0 place-items-center rounded-md text-text-3 hover:bg-surface-hover hover:text-text aria-pressed:bg-surface-hover aria-pressed:text-text";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function GitReviewDesktop({ view }: { view: GitReviewView }) {
  const { review } = view;
  const { focused, totals } = review;
  const root = useRef<HTMLDivElement>(null);
  const [keys, setKeys] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [confirm, setConfirm] = useState<GitConfirmRequest | null>(null);
  const actions = useBlockActions(view);

  // The keys stay with the tab when an answer takes away the button that had focus,
  // and when it opens from Source Control. Never away from somewhere to type.
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const lost = !active || active === document.body || active.getClientRects().length === 0;
    if (lost) root.current?.focus({ preventScroll: true });
  }, [review.focus?.path, review.focus?.key]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    // React bubbles a key press in a portal through here too: the Discard file… question
    // is one, and N typed in it must not discard the block behind it.
    if (!root.current?.contains(e.target as Node)) return;
    if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return;
    const key = e.key.toLowerCase();
    const block = focused?.block;
    const open = block?.state === "open";
    if (key === "j" || key === "k") review.step(key === "j" ? 1 : -1);
    else if (key === "y" && open) review.pick ? review.stagePicked() : review.stage(focused!.review.path, block!.key);
    else if (key === "n" && open && !review.pick) review.discard(focused!.review.path, block!.key);
    else if (key === "l" && open && block!.hunk) review.pick ? review.setPick(null) : review.startPick();
    else if (key === "escape" && (review.pick || filesOpen)) {
      review.setPick(null);
      setFilesOpen(false);
    } else return;
    e.preventDefault();
  };

  const pickFile = (path: string) => {
    review.focusFile(path);
    setFilesOpen(false);
  };
  const operation = review.changes?.operation ?? null;
  const rail = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-1">
        <ReviewFileList
          reviews={review.reviews}
          conflicts={review.conflicts}
          current={focused?.review.path ?? null}
          mobile={false}
          onPick={pickFile}
          onResolve={view.resolve}
        />
      </div>
      {/* Mid-merge the commit is the merge's own, made by Continue in Source Control. */}
      {review.changes && totals.files > 0 && !operation && (
        <GitCommitComposer
          projectName={view.projectName}
          branch={view.branch}
          totals={review.commitTotals}
          lastCommit={review.changes.lastCommit}
          busy={review.busy}
          onCommit={review.commit}
          onUndoCommit={review.undoCommit}
          className="shrink-0 border-t border-border-soft bg-panel"
        />
      )}
    </>
  );
  const open = totals.blocks - totals.staged;

  // Nothing at all to show: the empty state takes the whole tab, with the toast
  // over it so a commit that just emptied it can still be undone.
  if (!review.reviews.length && !review.conflicts.length) {
    return (
      <div data-testid="git-review" className="relative flex h-full flex-col overflow-hidden bg-bg">
        {review.error && <div className="shrink-0 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{review.error}</div>}
        <ReviewEmpty conflicts={0} onGraph={view.openGraph} />
        {review.toast && <ReviewToastView toast={review.toast} mobile={false} onClose={review.dismissToast} />}
      </div>
    );
  }

  return (
    <div
      ref={root}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="git-review"
      className="@container flex h-full flex-col overflow-hidden bg-bg outline-none"
    >
      <div className="relative flex shrink-0 flex-wrap items-center gap-x-[18px] gap-y-2 border-b border-border-soft bg-panel py-2.5 pr-3 pl-4">
        <div className="min-w-0">
          <h3 className="m-0 text-sm font-semibold leading-5">Review changes</h3>
          <p className="m-0 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-text-3">
            <GitBranch className="size-3 shrink-0" />
            <b className="truncate font-medium text-text-2">{view.branch ?? "detached HEAD"}</b>
            <span>· {plural(totals.files, "file")}</span>
            <LineCounts added={totals.added} removed={totals.removed} />
          </p>
        </div>
        {totals.blocks + totals.discarded > 0 && (
          <div className="flex items-center gap-2.5 whitespace-nowrap text-[12.5px] text-text-2">
            <ReviewProgress reviews={review.reviews} />
            <span><b className="font-semibold text-text">{totals.staged} of {totals.blocks}</b> blocks staged</span>
            <span className="text-text-3">{open ? `· ${open} to decide` : "· all decided"}</span>
          </div>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-text-2 @min-[760px]:hidden"
            aria-expanded={filesOpen}
            onClick={() => setFilesOpen(!filesOpen)}
          >
            <FolderTree />{plural(review.reviews.length + review.conflicts.length, "file")}
          </Button>
          <Button variant="outline" size="sm" disabled={!open} onClick={review.stageAll}>
            <Check />Stage all
          </Button>
          <button
            type="button"
            className={toolButton}
            aria-pressed={keys}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            onClick={() => setKeys(!keys)}
          >
            <Keyboard className="size-4" />
          </button>
        </div>
      </div>
      {keys && (
        <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-b border-border-soft bg-panel px-4 py-2 text-[11.5px] text-text-3">
          <span className="inline-flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd>next / previous block</span>
          <span className="inline-flex items-center gap-1"><Kbd>Y</Kbd>stage</span>
          <span className="inline-flex items-center gap-1"><Kbd>N</Kbd>discard</span>
          <span className="inline-flex items-center gap-1"><Kbd>L</Kbd>pick lines</span>
          <span className="inline-flex items-center gap-1"><Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd><Kbd>↵</Kbd>commit</span>
        </div>
      )}

      {review.error && <div className="shrink-0 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{review.error}</div>}

      <div className="relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] @min-[760px]:grid-cols-[272px_minmax(0,1fr)]">
        <aside aria-label="Changed files" className="hidden min-h-0 flex-col border-r border-border-soft bg-panel @min-[760px]:flex">
          {rail}
        </aside>
        {filesOpen && (
          <>
            <div className="absolute inset-0 z-20 bg-black/30 @min-[760px]:hidden" onClick={() => setFilesOpen(false)} />
            <aside
              aria-label="Changed files"
              className="absolute inset-y-0 left-0 z-30 flex w-[min(288px,85%)] flex-col border-r border-border bg-panel shadow-[var(--shadow-float)] @min-[760px]:hidden"
            >
              {rail}
            </aside>
          </>
        )}

        <section aria-label="Changes" className="relative flex min-h-0 min-w-0 flex-col">
          {focused ? (
            <>
              <FileHeader view={view} />
              <div className="relative flex min-h-0 flex-1 flex-col">
                <CodePane view={view} actions={actions} />
                {review.toast && <ReviewToastView toast={review.toast} mobile={false} onClose={review.dismissToast} />}
              </div>
              <BottomBar view={view} onDiscardFile={setConfirm} />
            </>
          ) : (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <ReviewEmpty conflicts={review.conflicts.length} onGraph={view.openGraph} />
              {review.toast && <ReviewToastView toast={review.toast} mobile={false} onClose={review.dismissToast} />}
            </div>
          )}
        </section>
      </div>
      <GitConfirm request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/** The blocks' answers, read through a ref so a memoized block never calls a stale one. */
export function useBlockActions(view: GitReviewView): { current: BlockActions } {
  const { review } = view;
  const path = review.focused?.review.path ?? "";
  const actions = useRef<BlockActions>(null!);
  actions.current = {
    focus: (key) => review.focusBlock(path, key),
    stage: (key) => review.stage(path, key),
    discard: (key) => review.discard(path, key),
    unstage: (key) => review.unstage(path, key),
    undoDiscard: review.undoDiscard,
    startPick: review.startPick,
    togglePickLine: review.togglePickLine,
    setPick: review.setPick,
    stagePicked: review.stagePicked,
  };
  return actions;
}

function FileHeader({ view }: { view: GitReviewView }) {
  const { review } = view.review.focused!;
  const [dir, name] = splitPath(review.path);
  const listed = review.file;
  const deleted = listed?.x === "D" || listed?.y === "D";
  return (
    <div className="relative flex min-h-12 shrink-0 flex-wrap items-center gap-x-[9px] gap-y-1.5 border-b border-border-soft py-2 pr-3 pl-4">
      <FileIcon name={name} className="size-4" />
      <span className={cn("whitespace-nowrap text-sm font-semibold", deleted && "text-text-2 line-through")}>{name}</span>
      {dir && (
        <span dir="rtl" title={review.path} className="min-w-10 shrink truncate text-left text-xs text-text-3">
          <bdi>{dir}</bdi>
        </span>
      )}
      {listed && <StatusTile letter={changeLetter(listed)} />}
      <LineCounts added={review.added} removed={review.removed} />
      <span className="flex-1" />
      {listed && listed.y !== "D" && (
        <Button variant="ghost" size="sm" className="text-text-2" onClick={() => view.openFile(review.path)}>
          <ExternalLink />Open file
        </Button>
      )}
    </div>
  );
}

function CodePane({ view, actions }: { view: GitReviewView; actions: { current: BlockActions } }) {
  const { review } = view;
  const focused = review.focused!;
  const scroller = useRef<HTMLDivElement>(null);
  const [, name] = splitPath(focused.review.path);
  const lang = reviewLanguage(focused.review.path);
  const busy = !!review.busy;

  // Bring the block in focus into view, unless it already is — and again once
  // the file's lines arrive, which grows every block above it and this one.
  const loaded = !!focused.block.parts;
  useLayoutEffect(() => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`[data-block-key="${CSS.escape(focused.block.key)}"]`);
    if (!box || !el) return;
    const top = el.offsetTop - 28;
    const bottom = el.offsetTop + Math.min(el.offsetHeight, box.clientHeight - 48);
    if (el.offsetTop < box.scrollTop + 8 || bottom > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top);
  }, [focused.review.path, focused.block.key, loaded]);

  return (
    <div
      ref={scroller}
      data-testid="git-review-code"
      className="relative min-h-0 flex-1 overflow-auto bg-bg pt-2.5 pb-7 font-mono text-[12px] leading-[1.7] [tab-size:4]"
    >
      {review.items.map((item) => item.kind === "gap" ? (
        <ReviewGap key={item.key} lines={item.lines} compact={false} />
      ) : (
        <ReviewBlockCard
          key={item.block.key}
          name={name}
          oldPath={focused.review.file?.oldPath}
          block={item.block}
          index={item.index}
          total={item.total}
          focused={item.block.key === focused.block.key}
          pick={item.block.key === focused.block.key ? review.pick : null}
          compact={false}
          lang={lang}
          busy={busy}
          actions={actions}
        />
      ))}
    </div>
  );
}

function BottomBar({ view, onDiscardFile }: { view: GitReviewView; onDiscardFile: (request: GitConfirmRequest) => void }) {
  const { review } = view;
  const { review: file, index } = review.focused!;
  const open = file.open;
  const hasNext = review.reviews.length > 1;
  const askDiscard = (anchor: HTMLElement) => {
    if (!file.file) return;
    const summary = discardSummary([file.file]);
    onDiscardFile({
      anchor,
      title: summary.title,
      body: summary.body,
      confirmLabel: summary.confirm,
      onConfirm: () => review.discardFile(file.path),
    });
  };
  return (
    <div className="relative flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-border-soft bg-panel px-3 py-2 text-[12.5px] text-text-2">
      <div className="inline-flex items-center gap-0.5 rounded-lg bg-text/6 p-0.5">
        <button type="button" className={toolButton} title="Previous block (K)" aria-label="Previous block" onClick={() => review.step(-1)}>
          <ChevronUp className="size-3.5" />
        </button>
        <span className="min-w-[92px] text-center text-xs font-medium text-text-2">Block {index + 1} of {file.blocks.length}</span>
        <button type="button" className={toolButton} title="Next block (J)" aria-label="Next block" onClick={() => review.step(1)}>
          <ChevronDown className="size-3.5" />
        </button>
      </div>
      <span className="min-w-0 truncate">
        {open ? <><b className="font-semibold text-text">{open}</b> to decide in this file</> : "This file is done"}
      </span>
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        disabled={!open || !file.file}
        onClick={(e) => askDiscard(e.currentTarget)}
      >
        <Trash2 />Discard file…
      </Button>
      <Button variant="outline" size="sm" disabled={!open} onClick={() => review.stageFile(file.path)}>
        <Check />Stage file
      </Button>
      <Button size="sm" disabled={!hasNext} onClick={review.nextFile}>
        Next file<ArrowRight />
      </Button>
    </div>
  );
}
