/**
 * The parts the change tray (desktop) and the change sheet (phone) share: a file's group of
 * edits, one edit with its answers, the line that reports an answer, and what reverting the
 * whole turn will do — worked out by the server from the session's history before anything is
 * written, with the lines a later turn changed again named and left alone.
 */
import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FileIcon } from "@/lib/file-icons";
import { ArrowUp, Bot, Check, RotateCcw, TriangleAlert, Undo2, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { FileEditFragment, TurnFileChange } from "@/lib/aggregate-turn-file-changes";
import { editKey, type EditReview } from "@/lib/turn-review";
import { turnLabel, type SessionTurn } from "@/lib/session-turns";
import type { TurnReview, TurnReviewNotice } from "@/hooks/use-turn-review";
import { useSessionTurnsStore } from "@/stores/session-turns-store";
import type { TurnRevertFile, TurnRevertResult } from "../../../shared/session-file-changes";
import { useSessionChanges } from "./session-changes-context";
import { ChangeCounts } from "./change-file-row";

const EditDiffPreview = lazy(() => import("./edit-diff-preview"));

export function splitPath(path: string): { base: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? { base: path, dir: "" } : { base: path.slice(i + 1), dir: path.slice(0, i) };
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 edits in 2 files". */
export function editsInFiles(changes: readonly TurnFileChange[]): string {
  const edits = changes.reduce((n, c) => n + c.edits.length, 0);
  return `${plural(edits, "edit")} in ${plural(changes.length, "file")}`;
}

const answerButton = "inline-flex items-center gap-1.5 whitespace-nowrap border font-medium transition-colors disabled:opacity-50";

function Answers({ review, mobile, busy, onKeep, onRevert }: {
  review: EditReview;
  mobile: boolean;
  busy: boolean;
  onKeep: () => void;
  onRevert: () => void;
}) {
  const size = mobile ? "h-11 flex-1 justify-center rounded-[10px] px-3.5 text-sm" : "h-[26px] rounded-[7px] px-2.5 text-xs";
  return (
    <>
      <button
        type="button"
        disabled={busy}
        title={review.keys.length > 1 ? `Put back the ${review.keys.length} blocks this edit wrote` : "Put these lines back"}
        onClick={onRevert}
        className={cn(answerButton, size, "border-border bg-bg text-text hover:border-error/50 hover:text-error")}
      >
        <RotateCcw className={mobile ? "size-5" : "size-3.5"} />Revert
      </button>
      <button
        type="button"
        disabled={busy}
        title="Keep this change"
        onClick={onKeep}
        className={cn(answerButton, size, "border-transparent bg-primary text-primary-foreground hover:bg-primary/90")}
      >
        <Check className={mobile ? "size-5" : "size-3.5"} />Keep
      </button>
    </>
  );
}

/** One edit: its place, a way to its tool card, its answers, and its lines while it is open. */
function EditCard({ change, edit, index, review, mobile, busy, actions, onJump }: {
  change: TurnFileChange;
  edit: FileEditFragment;
  index: number;
  review: EditReview | undefined;
  mobile: boolean;
  busy: boolean;
  actions: Pick<TurnReview, "keep" | "revert" | "change">;
  onJump: (editRef: string) => void;
}) {
  const key = editKey(change.filePath, edit);
  const state = review?.state ?? null;
  const decided = state === "kept" || state === "reverted";
  const canChange = state === "kept" ? (review?.keys.length ?? 0) > 0 : state === "reverted" && !!review?.undoId;
  return (
    <div
      data-edit-key={key}
      data-state={state ?? "unknown"}
      className={cn("mt-1.5 rounded-lg border border-border-soft bg-bg", decided && "border-dashed")}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1.5 py-1 pr-1.5 pl-2.5 text-[11.5px] text-text-subtle",
          mobile ? "min-h-[52px]" : "min-h-9",
          !decided && "border-b border-border-soft",
        )}
      >
        <span><b className="font-semibold text-text-2">Edit {index + 1}</b> of {change.edits.length}</span>
        {edit.editRef && (
          <button
            type="button"
            title="Scroll the chat to the tool card that made this edit"
            onClick={() => onJump(edit.editRef!)}
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 font-medium text-text-2 hover:bg-surface-hover hover:text-text",
              mobile ? "min-h-11" : "h-6",
            )}
          >
            <ArrowUp className="size-3.5" />{mobile ? "Chat" : "Show in chat"}
          </button>
        )}
        <span className="flex-1" />
        {state === "open" && !mobile && (
          <Answers review={review!} mobile={false} busy={busy} onKeep={() => actions.keep(key)} onRevert={() => actions.revert(key)} />
        )}
        {decided && (
          <>
            <span className={cn("inline-flex items-center gap-1 font-semibold", state === "kept" ? "text-primary" : "text-error")}>
              {state === "kept" ? <Check className="size-3.5" /> : <RotateCcw className="size-3.5" />}
              {state === "kept" ? "Kept" : "Reverted"}
            </span>
            {canChange && (
              <button
                type="button"
                disabled={busy}
                title={state === "reverted" ? "Put back what the agent wrote here" : "Open this edit again"}
                onClick={() => actions.change(key)}
                className={cn(
                  "inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 font-medium text-text-2 hover:bg-surface-hover hover:text-text disabled:opacity-50",
                  mobile ? "min-h-11" : "h-6",
                )}
              >
                <Undo2 className="size-3.5" />Change
              </button>
            )}
          </>
        )}
      </div>
      {!decided && (
        <div className="px-1 py-1">
          <Suspense fallback={<div className="h-4" />}>
            <EditDiffPreview oldStr={edit.oldStr} newStr={edit.newStr} filePath={change.filePath} />
          </Suspense>
        </div>
      )}
      {/* On a phone the two answers sit under the lines, where the thumb is after reading them. */}
      {state === "open" && mobile && (
        <div className="flex gap-2 border-t border-border-soft p-2">
          <Answers review={review!} mobile busy={busy} onKeep={() => actions.keep(key)} onRevert={() => actions.revert(key)} />
        </div>
      )}
    </div>
  );
}

export function FileGroup({ change, review, mobile, onJump }: {
  change: TurnFileChange;
  review: TurnReview;
  mobile: boolean;
  onJump: (editRef: string) => void;
}) {
  const { base, dir } = splitPath(change.filePath);
  return (
    <div data-file-group={change.filePath}>
      <div className="flex min-h-10 items-center gap-2 pt-1.5 text-[13px]" title={change.filePath}>
        <FileIcon name={base} className="size-4 shrink-0" />
        <b className="shrink-0 font-semibold">{base}</b>
        {dir && (
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left text-xs text-text-subtle [direction:rtl]">
            <bdi>{dir}</bdi>
          </span>
        )}
        {change.viaSubagent && (
          <span title="Changed by a sub-agent" className="inline-flex shrink-0 items-center gap-[3px] rounded px-[5px] text-[10px] font-semibold leading-[15px] text-info bg-[color-mix(in_srgb,var(--info)_14%,transparent)]">
            <Bot className="size-3" />Sub-agent
          </span>
        )}
        <span className="flex-1" />
        <ChangeCounts added={change.linesAdded} removed={change.linesRemoved} className="shrink-0 font-mono text-[11px]" />
      </div>
      {change.edits.map((edit, i) => (
        <EditCard
          key={edit.editRef ?? `${edit.toolUseId}:${i}`}
          change={change}
          edit={edit}
          index={i}
          review={review.reviews.get(editKey(change.filePath, edit))}
          mobile={mobile}
          busy={review.busy}
          actions={review}
          onJump={onJump}
        />
      ))}
    </div>
  );
}

/** What an answer did: what went wrong, or what it reverted, with Undo. */
export function NoticeLine({ notice, mobile, busy, onUndo, onDismiss }: {
  notice: TurnReviewNotice;
  mobile: boolean;
  busy: boolean;
  onUndo: (undoId: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="turn-review-notice"
      className={cn("flex items-center gap-2 border-b border-border-soft bg-panel-2 pl-3.5", mobile ? "min-h-12 pr-1 text-sm" : "min-h-9 pr-1.5 text-xs")}
    >
      <span className="min-w-0 flex-1">{notice.text}</span>
      {notice.undoId && (
        <Button variant="ghost" size={mobile ? "sm" : "xs"} className={cn("text-primary hover:text-primary", mobile && "h-11")} disabled={busy} onClick={() => onUndo(notice.undoId!)}>
          Undo
        </Button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className={cn("inline-grid shrink-0 place-items-center rounded-md text-text-subtle hover:bg-surface-hover hover:text-text", mobile ? "size-11" : "size-6")}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Asking to revert the turn: the preview the server worked out, then the revert itself. */
export function useRevertTurnFlow(review: TurnReview) {
  const [state, setState] = useState<{ preview: TurnRevertResult | null; loading: boolean; moved: boolean } | null>(null);
  const { previewRevertTurn, applyRevertTurn } = review;
  const cancel = useCallback(() => setState(null), []);
  const start = useCallback(async () => {
    setState({ preview: null, loading: true, moved: false });
    const preview = await previewRevertTurn();
    setState(preview ? { preview, loading: false, moved: false } : null);
  }, [previewRevertTurn]);
  const confirm = useCallback(async () => {
    if (!state?.preview) return;
    setState({ ...state, loading: true });
    const again = await applyRevertTurn(state.preview);
    setState(again ? { preview: { files: again.files }, loading: false, moved: true } : null);
  }, [state, applyRevertTurn]);
  return {
    open: !!state,
    preview: state?.preview ?? null,
    loading: state?.loading ?? false,
    /** A file moved on between the preview and the revert: this is the newer preview. */
    moved: state?.moved ?? false,
    start,
    cancel,
    confirm,
  };
}

/** The files a revert writes, and what it puts back in each. */
export function revertedFiles(preview: TurnRevertResult): TurnRevertFile[] {
  return preview.files.filter((f) => f.action !== "none");
}

function fileWhat(f: TurnRevertFile): string {
  if (f.action === "delete") return "file removed";
  if (f.action === "restore") return "file put back";
  return plural(f.changes, "change");
}

/** Who changed a skipped line since: a turn of this chat, or someone outside it. */
function useLaterLabels(): (by: readonly string[]) => string {
  const sessionId = useSessionChanges()?.sessionId;
  const byCall = useSessionTurnsStore((s) => (sessionId ? s.bySession[sessionId]?.byCall : undefined));
  return (by) => {
    const turns: SessionTurn[] = [];
    let outside = false;
    for (const call of by) {
      const turn = call ? byCall?.get(call) : undefined;
      if (turn && !turns.includes(turn)) turns.push(turn);
      else if (!turn) outside = true;
    }
    const names = turns.map(turnLabel);
    if (outside || names.length === 0) names.push(by.length === 0 ? "a later change" : "a change outside this chat");
    return names.join(" and ");
  };
}

/** The body of the confirmation: what goes back, and what stays because something changed it since. */
export function RevertTurnSummary({ preview, mobile }: { preview: TurnRevertResult; mobile: boolean }) {
  const later = useLaterLabels();
  const files = revertedFiles(preview);
  const skipped = preview.files.flatMap((f) => f.skipped.map((s) => ({ f, s })));
  const failed = preview.files.filter((f) => f.error);
  const row = (children: ReactNode, key: string, warn = false) => (
    <div
      key={key}
      className={cn(
        "flex items-center gap-2.5 border-b border-border-soft px-3.5 py-1.5 last:border-b-0",
        mobile ? "min-h-[52px] text-sm" : "min-h-9 text-[12.5px]",
        warn && "bg-[color-mix(in_srgb,var(--warning)_9%,transparent)]",
      )}
    >
      {children}
    </div>
  );
  if (files.length === 0 && skipped.length === 0 && failed.length === 0) {
    return <p className="m-0 text-text-2">Nothing this turn wrote is left to put back.</p>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border-soft" data-testid="revert-turn-summary">
      {files.map((f) => {
        const { base, dir } = splitPath(f.path);
        return row(
          <>
            <FileIcon name={base} className="size-4 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
              <b className="truncate font-medium">{base}</b>
              {/* The folder gives way from its start; what happens to the file is never cut. */}
              <small className="flex min-w-0 gap-1 whitespace-nowrap text-[11.5px] text-text-subtle">
                {dir && (
                  <span className="min-w-0 overflow-hidden text-ellipsis text-left [direction:rtl]">
                    <bdi>{dir}</bdi>
                  </span>
                )}
                <span className="shrink-0">{dir && "· "}{fileWhat(f)}</span>
              </small>
            </span>
            <ChangeCounts added={f.added} removed={f.removed} className="shrink-0 font-mono text-[11px]" />
          </>,
          `f:${f.path}`,
        );
      })}
      {skipped.map(({ f, s }, i) =>
        row(
          <>
            <TriangleAlert className="size-4 shrink-0 text-warning" />
            <span className="min-w-0 flex-1 leading-[1.4] text-text-2">
              <b className="font-semibold text-text">{splitPath(f.path).base}</b> line {s.line} stays as it is — {later(s.by)} changed it again.
            </span>
          </>,
          `s:${f.path}:${i}`,
          true,
        ),
      )}
      {failed.map((f) =>
        row(
          <>
            <TriangleAlert className="size-4 shrink-0 text-error" />
            <span className="min-w-0 flex-1 leading-[1.4] text-text-2">
              <b className="font-semibold text-text">{splitPath(f.path).base}</b>: {f.error}
            </span>
          </>,
          `e:${f.path}`,
          true,
        ),
      )}
    </div>
  );
}

/** The confirmation's own lines around the summary, shared by the popover and the sheet. */
export function RevertTurnBody({ flow, mobile }: { flow: ReturnType<typeof useRevertTurnFlow>; mobile: boolean }) {
  if (!flow.preview) return <p className="m-0 text-text-2">Working out what this turn wrote…</p>;
  const files = revertedFiles(flow.preview);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const skips = flow.preview.files.some((f) => f.skipped.length > 0);
  return (
    <>
      {flow.moved && <p className="m-0 mb-2 font-medium text-warning">A file changed since — this is what reverting does now.</p>}
      {files.length > 0 && (
        <p className="m-0 mb-3 text-text-2">
          Puts back what this answer wrote, on disk: {plural(files.reduce((n, f) => n + Math.max(f.changes, 1), 0), "change")} in {plural(files.length, "file")},{" "}
          <span className="font-mono text-success">+{added}</span> <span className="font-mono text-error">−{removed}</span> undone.
          {!skips && " No later turn changed these lines."}
        </p>
      )}
      <RevertTurnSummary preview={flow.preview} mobile={mobile} />
      <p className={cn("m-0 mt-3 text-text-subtle", mobile ? "text-[13px]" : "text-xs")}>
        The chat itself stays as it is. You can undo it right after.
      </p>
    </>
  );
}
