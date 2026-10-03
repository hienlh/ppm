/**
 * What the Review tab's two layouts share beyond markup: where the block in focus stands, the
 * next file, how a decided block is opened again, and the area under the file header — blocks,
 * a whole-file card, or the wait for a diff.
 */
import { Button } from "@/components/ui/button";
import { Check, Loader2, RotateCcw, Undo2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { fileOutcome, railOrder, type BlockState, type FileReview } from "@/lib/session-review-model";
import type { SessionReview } from "@/hooks/use-session-review";
import type { SessionTurn } from "@/lib/session-turns";
import { ReviewCode, type ReviewCodeActions } from "./review-code";
import { reviewLanguage } from "./review-tokens";

export interface ReviewView {
  review: SessionReview;
  projectPath?: string;
  providerId?: string;
  chatTitle?: string;
  openChat: () => void;
  openFile: (path: string) => void;
  /** Each call's turn, for the turns a block names. */
  turns: ReadonlyMap<string, SessionTurn>;
  /** Open the chat at the call that wrote a block, or at its turn's prompt. */
  showInChat: (turn: SessionTurn, call: string) => void;
  /** How the block in focus was answered; null with nothing in focus. */
  focusState: BlockState | null;
  /** Its place among its file's blocks, 0-based. */
  place: { index: number; total: number } | null;
  nextFile: FileReview | null;
  /** Answer the block in focus; a file with no blocks to show is answered whole, a revert of it confirmed first. */
  keepFocused: () => void;
  revertFocused: (confirm: () => void) => void;
  /** Open the decided block in focus again: a kept one is reopened, a reverted one's revert undone. */
  changeFocused: (() => void) | null;
  codeActions: ReviewCodeActions;
}

export function reviewView(p: Omit<ReviewView, "focusState" | "place" | "nextFile" | "keepFocused" | "revertFocused" | "changeFocused" | "codeActions">): ReviewView {
  const { review } = p;
  const { focused, focus, pane, reviews } = review;

  const block = focused && focus ? focused.blocks.find((b) => b.key === focus.key) : undefined;
  let place: ReviewView["place"] = null;
  if (focused && block) place = { index: focused.blocks.indexOf(block), total: focused.blocks.length };
  const item = pane.kind === "blocks" && focus ? pane.model.items.find((i) => i.kind === "block" && i.key === focus.key) : undefined;
  if (item?.kind === "block" && pane.kind === "blocks") place = { index: item.index, total: pane.model.total };

  const rail = railOrder(reviews);
  const at = focused ? rail.findIndex((r) => r.path === focused.path) : -1;
  const nextFile = rail.find((r, n) => n > at && r.open > 0) ?? rail.find((r) => r.open > 0 && r.path !== focused?.path) ?? null;

  const whole = pane.kind === "whole";
  const undoId = item?.kind === "block" ? item.undoId : whole ? pane.undoId : undefined;
  let changeFocused: (() => void) | null = null;
  if (focus && block?.state === "kept") changeFocused = () => review.reopenBlock(focus.key);
  else if (focus && block?.state === "reverted" && undoId) changeFocused = () => review.undo(undoId, focus);

  return {
    ...p,
    focusState: block?.state ?? null,
    place,
    nextFile,
    keepFocused: () => {
      if (!focus || block?.state !== "open") return;
      if (whole) review.keepFile();
      else review.keepBlock(focus.key);
    },
    revertFocused: (confirm) => {
      if (!focus || block?.state !== "open") return;
      if (whole) confirm();
      else review.revertBlock(focus.key);
    },
    changeFocused,
    codeActions: {
      focus: (key) => focused && review.setFocus({ path: focused.path, key }),
      keep: (key) => review.keepBlock(key),
      revert: (key) => review.revertBlock(key),
      reopen: (key) => review.reopenBlock(key),
      undo: (id, key) => focused && review.undo(id, { path: focused.path, key }),
      showInChat: p.showInChat,
    },
  };
}

/** Under the file header: the blocks, a card for a file answered whole, or the wait for its diff. */
export function PaneBody({ view, compact, onRevertFile }: { view: ReviewView; compact: boolean; onRevertFile: () => void }) {
  const { pane, focus } = view.review;
  if (pane.kind === "blocks") {
    return (
      <ReviewCode
        key={pane.review.path}
        file={pane.review.file}
        model={pane.model}
        focusKey={focus?.path === pane.review.path ? focus.key : null}
        compact={compact}
        lang={reviewLanguage(pane.review.path)}
        turns={view.turns}
        actions={view.codeActions}
      />
    );
  }
  if (pane.kind === "whole") return <WholeFile view={view} review={pane.review} compact={compact} onRevertFile={onRevertFile} />;
  if (pane.kind === "error") {
    return <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-text-subtle">{pane.message}</div>;
  }
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="size-4 animate-spin text-text-subtle" />
    </div>
  );
}

function WholeFile({ view, review, compact, onRevertFile }: { view: ReviewView; review: FileReview; compact: boolean; onRevertFile: () => void }) {
  const file = review.file;
  const why = review.gone
    ? "Reverted: the file is back the way it was."
    : file.binary ? "A binary file has no lines to compare, so it is kept or reverted whole."
      : file.tooLarge ? "This file is too large to show, so it is kept or reverted whole."
        : "This diff is too large to cut into blocks, so the file is kept or reverted whole.";
  const outcome = review.open === 0 ? fileOutcome(review) : null;
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-bg p-3">
      <div
        data-testid="review-whole-file"
        className={cn("rounded-[10px] border border-border-soft bg-panel p-4 text-[13px] text-text-2", outcome && "border-dashed")}
      >
        <p className="m-0">{why}</p>
        {!compact && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {outcome ? (
              <>
                <span className={cn("inline-flex items-center gap-1 font-semibold", outcome.tone === "kept" ? "text-primary" : outcome.tone === "reverted" ? "text-error" : "text-text-subtle")}>
                  {outcome.tone === "reverted" ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
                  {outcome.label}
                </span>
                {view.changeFocused && (
                  <Button variant="ghost" size="xs" className="text-text-secondary" onClick={view.changeFocused}>
                    <Undo2 />Change
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" className="hover:text-error" onClick={onRevertFile}>
                  <RotateCcw />Revert file…
                </Button>
                <Button size="sm" onClick={() => view.review.keepFile()}>
                  <Check />Keep file
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
