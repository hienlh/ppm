/**
 * Desktop presentation of the change tray: an inline, non-modal panel directly below the
 * message's action bar. Every edit the turn made, grouped by file, each with its lines and —
 * once the session's list can say which blocks it wrote — Keep and Revert. The head keeps the
 * whole turn, reverts it, or opens the Review tab.
 */
import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Check, FileDiff, RotateCcw, X } from "@/lib/icons";
import { ownsGlobalShortcut } from "@/lib/owns-global-shortcut";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";
import { turnLabel, type SessionTurn } from "@/lib/session-turns";
import type { TurnReview } from "@/hooks/use-turn-review";
import { ChangeCounts } from "./change-file-row";
import { changeTotals } from "./turn-change-pill";
import { FileGroup, NoticeLine, RevertTurnBody, editsInFiles, revertedFiles, useRevertTurnFlow } from "./turn-change-review";

/**
 * Several messages in one chat can have a tray open at once, and `ownsGlobalShortcut`
 * only narrows to the focused *tab*. The most recently opened tray claims the keys.
 */
let activeTrayId: string | null = null;

/** `ownsGlobalShortcut` resolves the owning tab; it says nothing about text entry. */
function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export function TurnChangeTray({ changes, turn, review, onJump, onClose }: {
  changes: TurnFileChange[];
  turn: SessionTurn | undefined;
  review: TurnReview;
  onJump: (editRef: string) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trayId = useId();
  const flow = useRevertTurnFlow(review);
  const totals = changeTotals(changes);

  // Inline and non-modal: focus moves in, but is deliberately not trapped.
  useEffect(() => {
    activeTrayId = trayId;
    containerRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    return () => {
      if (activeTrayId === trayId) activeTrayId = null;
    };
  }, [trayId]);

  const cancelRevert = flow.cancel;
  const confirming = flow.open;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || activeTrayId !== trayId) return;
      if (!ownsGlobalShortcut(containerRef.current) || isTextEntry(document.activeElement)) return;
      e.preventDefault();
      if (confirming) cancelRevert();
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [trayId, confirming, cancelRevert, onClose]);

  const nothingToRevert = !!flow.preview && revertedFiles(flow.preview).length === 0;

  return (
    <div ref={containerRef} data-testid="turn-change-tray" className="mt-0.5 rounded-xl border border-border bg-panel shadow-[var(--shadow-float)]">
      <div className="relative flex min-h-12 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border-soft py-1.5 pr-2 pl-3.5">
        <h4 className="m-0 text-[13px] font-semibold">Changed this turn</h4>
        <span className="inline-flex items-center gap-1.5 text-xs text-text-subtle">
          {editsInFiles(changes)} · <ChangeCounts added={totals.added} removed={totals.removed} className="font-mono text-[11px]" />
        </span>
        <div className="relative ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {review.enabled && turn && (
            <Button
              variant="ghost"
              size="sm"
              className="text-text-secondary"
              aria-expanded={flow.open}
              disabled={review.busy && !flow.open}
              onClick={() => (flow.open ? flow.cancel() : void flow.start())}
            >
              <RotateCcw />Revert turn…
            </Button>
          )}
          {review.summary.open > 0 && (
            <Button size="sm" disabled={review.busy} onClick={review.keepAll}>
              <Check />Keep all
            </Button>
          )}
          {review.enabled && (
            <Button variant="ghost" size="sm" className="text-primary hover:text-primary" onClick={() => review.openReview(changes[0]?.filePath)}>
              <FileDiff />Review in tab
            </Button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close change tray"
            title="Close (Esc)"
            className="inline-grid size-8 shrink-0 place-items-center rounded-lg text-text-subtle transition-colors hover:bg-surface hover:text-text-primary"
          >
            <X className="size-3.5" />
          </button>
          {flow.open && turn && (
            <div
              role="dialog"
              aria-label={`Revert ${turnLabel(turn)}?`}
              data-testid="revert-turn-confirm"
              className="absolute top-full right-0 z-40 mt-1.5 w-[400px] max-w-[calc(100vw-48px)] rounded-xl border border-border bg-panel-2 p-3.5 text-[12.5px] leading-normal shadow-[var(--shadow-float),0_18px_40px_-16px_rgba(0,0,0,.6)]"
            >
              <h5 className="m-0 mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-text">
                <RotateCcw className="size-4 text-error" />Revert {turnLabel(turn)}?
              </h5>
              <RevertTurnBody flow={flow} mobile={false} />
              <div className="mt-3 flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={flow.cancel}>Cancel</Button>
                <Button variant="destructive" size="sm" disabled={flow.loading || !flow.preview || nothingToRevert} onClick={() => void flow.confirm()}>
                  <RotateCcw />Revert turn
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {review.notice && (
        <NoticeLine notice={review.notice} mobile={false} busy={review.busy} onUndo={review.undo} onDismiss={review.dismissNotice} />
      )}
      <div className="max-h-[560px] overflow-y-auto rounded-b-xl px-3 pt-1 pb-3">
        {changes.map((change) => (
          <FileGroup key={change.filePath} change={change} review={review} mobile={false} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}
