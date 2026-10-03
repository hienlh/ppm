/**
 * Phone presentation of the change tray: a modal bottom sheet holding every edit the turn made,
 * grouped by file, each answered with full-width Keep and Revert under its lines. The footer
 * keeps or reverts the whole turn; reverting asks first, in the same sheet.
 *
 * The panel is capped; the body scrolls inside it so the sheet itself never does.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Check, FileDiff, RotateCcw, X } from "@/lib/icons";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { cn } from "@/lib/utils";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";
import { turnLabel, turnTime, type SessionTurn } from "@/lib/session-turns";
import type { TurnReview } from "@/hooks/use-turn-review";
import { FileGroup, NoticeLine, RevertTurnBody, editsInFiles, revertedFiles, useRevertTurnFlow } from "./turn-change-review";

const footButton = "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-[10px] border px-3.5 text-sm font-medium disabled:opacity-50";

/** 44×44 icon control — the minimum touch target on a coarse pointer. */
function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-text-subtle transition-colors hover:bg-surface hover:text-text-primary"
    >
      {children}
    </button>
  );
}

function SheetHead({ title, sub, icon, onClose, children }: { title: string; sub?: string; icon?: ReactNode; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1 pt-0.5 pr-1.5 pb-2 pl-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {icon}
          <h4 className="m-0 min-w-0 truncate text-[15px] font-semibold">{title}</h4>
        </div>
        {sub && <p className="m-0 mt-0.5 line-clamp-2 text-xs text-text-subtle">{sub}</p>}
      </div>
      {children}
      <IconButton label="Close" onClick={onClose}>
        <X className="size-5" />
      </IconButton>
    </div>
  );
}

export function TurnChangeSheet({ changes, turn, review, open, onClose, onJump }: {
  changes: TurnFileChange[];
  turn: SessionTurn | undefined;
  review: TurnReview;
  open: boolean;
  onClose: () => void;
  onJump: (editRef: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const flow = useRevertTurnFlow(review);
  const { summary } = review;

  const close = () => {
    flow.cancel();
    onClose();
  };
  const jump = (editRef: string) => {
    close();
    onJump(editRef);
  };

  // Modal on phone: focus moves in and stays in. `BottomSheet` handles the scrim and
  // swipe-to-dismiss but not the keyboard, so Escape and the tab cycle live here.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    focusables()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (flow.open) flow.cancel();
        else close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, flow.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const nothingToRevert = !!flow.preview && revertedFiles(flow.preview).length === 0;
  const time = turn ? turnTime(turn.at) : "";

  return (
    <BottomSheet open={open} onClose={close} className="flex max-h-[90%] flex-col rounded-t-[14px] motion-reduce:animate-none">
      <div ref={panelRef} data-testid="turn-change-sheet" className="flex min-h-0 flex-1 flex-col">
        {flow.open && turn ? (
          <>
            <SheetHead
              title={`Revert ${turnLabel(turn)}?`}
              sub={[time, turn.prompt].filter(Boolean).join(" · ")}
              icon={<RotateCcw className="size-5 shrink-0 text-error" />}
              onClose={flow.cancel}
            />
            <div data-testid="revert-turn-confirm" className="min-h-0 flex-1 overflow-y-auto px-4 text-sm leading-normal">
              <RevertTurnBody flow={flow} mobile />
            </div>
            <div className="flex gap-2 px-4 pt-3 pb-1">
              <button type="button" className={cn(footButton, "border-border bg-panel-2 text-text")} onClick={flow.cancel}>Cancel</button>
              <button
                type="button"
                disabled={flow.loading || !flow.preview || nothingToRevert}
                className={cn(footButton, "border-transparent bg-[color-mix(in_srgb,var(--error)_85%,#000)] text-white")}
                onClick={() => void flow.confirm()}
              >
                <RotateCcw className="size-5" />Revert turn
              </button>
            </div>
          </>
        ) : (
          <>
            <SheetHead
              title="Changed this turn"
              sub={`${editsInFiles(changes)}${summary.kept > 0 ? ` · ${summary.kept} kept` : ""}`}
              onClose={close}
            >
              {review.enabled && (
                <button
                  type="button"
                  onClick={() => { close(); review.openReview(changes[0]?.filePath); }}
                  className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-primary"
                >
                  <FileDiff className="size-4" />Review
                </button>
              )}
            </SheetHead>
            {review.notice && (
              <NoticeLine notice={review.notice} mobile busy={review.busy} onUndo={review.undo} onDismiss={review.dismissNotice} />
            )}
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-border-soft px-3 pb-3">
              {changes.map((change) => (
                <FileGroup key={change.filePath} change={change} review={review} mobile onJump={jump} />
              ))}
            </div>
            {review.enabled && (turn || summary.open > 0) && (
              <div className="flex gap-2 px-3 pt-2 pb-1">
                {turn && (
                  <button
                    type="button"
                    disabled={review.busy}
                    className={cn(footButton, "border-border bg-panel-2 text-text")}
                    onClick={() => void flow.start()}
                  >
                    <RotateCcw className="size-5" />Revert turn…
                  </button>
                )}
                {summary.open > 0 && (
                  <button
                    type="button"
                    disabled={review.busy}
                    className={cn(footButton, "border-transparent bg-primary text-primary-foreground")}
                    onClick={review.keepAll}
                  >
                    <Check className="size-5" />Keep all {summary.open}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </BottomSheet>
  );
}
