/**
 * "Rewind code" on a prompt the person sent: puts the files back as they were before that message,
 * undoing what its turn and every turn after it wrote — Claude Code's "rewind code" checkpoint,
 * built on PPM's own per-session file history (`revert-turn` with the calls of all those turns),
 * so a line someone changed outside the chat since stays as it is and the whole rewind can be
 * undone. The chat itself is left alone; "Rewind and fork" also forks the conversation from here.
 */
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { History } from "@/lib/icons";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { rewindFrom } from "@/lib/session-turns";
import { useSessionTurnsStore } from "@/stores/session-turns-store";
import { announceReviewMarks, revertSessionTurn, undoSessionAnswer } from "@/lib/session-file-changes-client";
import type { TurnRevertResult } from "../../../shared/session-file-changes";
import { useSessionChanges } from "./session-changes-context";
import { ActionButton } from "./message-action-bar";
import { RevertTurnSummary, revertedFiles } from "./turn-change-review";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Stage =
  | { kind: "loading" }
  | { kind: "preview"; preview: TurnRevertResult; moved: boolean; busy: boolean }
  | { kind: "done"; text: string; undoId?: string; busy: boolean };

export function RewindCodeButton({ messageId, onFork }: { messageId: string; onFork?: () => void }) {
  const ctx = useSessionChanges();
  const turns = useSessionTurnsStore((s) => (ctx ? s.bySession[ctx.sessionId]?.turns : undefined));
  const rewind = useMemo(() => (turns ? rewindFrom(turns, messageId) : null), [turns, messageId]);
  const [stage, setStage] = useState<Stage | null>(null);
  const mobile = useIsMobile();

  const settle = useCallback(() => {
    if (!ctx) return;
    ctx.refresh();
    announceReviewMarks({ projectName: ctx.projectName, sessionId: ctx.sessionId });
  }, [ctx]);

  const fail = (e: unknown) => setStage({ kind: "done", text: e instanceof Error ? e.message : "The files could not be put back.", busy: false });

  const start = useCallback(async () => {
    if (!ctx || !rewind) return;
    setStage({ kind: "loading" });
    try {
      setStage({ kind: "preview", preview: await revertSessionTurn(ctx.projectName, ctx.sessionId, rewind.calls), moved: false, busy: false });
    } catch (e) {
      fail(e);
    }
  }, [ctx, rewind]);

  const confirm = useCallback(async (andFork: boolean) => {
    if (!ctx || !rewind || stage?.kind !== "preview") return;
    setStage({ ...stage, busy: true });
    try {
      const shown = stage.preview.files.map((f) => ({ path: f.path, version: f.version }));
      const result = await revertSessionTurn(ctx.projectName, ctx.sessionId, rewind.calls, shown);
      if (result.stale) {
        setStage({ kind: "preview", preview: { files: result.files }, moved: true, busy: false });
        return;
      }
      const failed = result.files.filter((f) => f.error);
      const written = revertedFiles(result).filter((f) => !f.error).length;
      setStage({
        kind: "done",
        text: failed.length > 0
          ? `${plural(failed.length, "file")} could not be written: ${failed[0]!.error}`
          : written > 0 ? `Rewound ${plural(written, "file")} to before this message.` : "Nothing to put back.",
        ...(result.undoId ? { undoId: result.undoId } : {}),
        busy: false,
      });
      if (andFork && failed.length === 0) onFork?.();
    } catch (e) {
      fail(e);
    } finally {
      settle();
    }
  }, [ctx, rewind, stage, onFork, settle]);

  const undo = useCallback(async (undoId: string) => {
    if (!ctx) return;
    setStage((s) => (s?.kind === "done" ? { ...s, busy: true } : s));
    try {
      const result = await undoSessionAnswer(ctx.projectName, ctx.sessionId, undoId);
      setStage({ kind: "done", text: result.stale ? "Nothing was put back: a file changed after the rewind." : "Undone: the files are as they were before the rewind.", busy: false });
    } catch (e) {
      fail(e);
    } finally {
      settle();
    }
  }, [ctx, settle]);

  if (!ctx || !rewind || rewind.calls.length === 0) return null;

  const files = stage?.kind === "preview" ? revertedFiles(stage.preview) : [];
  const nothing = stage?.kind === "preview" && files.length === 0 && stage.preview.files.every((f) => f.skipped.length === 0 && !f.error);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  const close = () => setStage(null);
  const intro = "Puts the files back as they were before this message, undoing what " + plural(rewind.turns, "turn") + " wrote. The chat itself stays as it is.";
  const body = (
    <>
      <div className="text-[12.5px] leading-normal">
        {stage?.kind === "loading" && <p className="m-0 text-text-2">Working out what changed since…</p>}
        {stage?.kind === "preview" && (
          <>
            {stage.moved && <p className="m-0 mb-2 font-medium text-warning">A file changed since — this is what rewinding does now.</p>}
            {nothing ? (
              <p className="m-0 text-text-2">Nothing written since this message is left to put back.</p>
            ) : (
              <>
                {files.length > 0 && (
                  <p className="m-0 mb-3 text-text-2">
                    {plural(files.length, "file")},{" "}
                    <span className="font-mono text-success">+{added}</span> <span className="font-mono text-error">−{removed}</span> undone.
                  </p>
                )}
                <RevertTurnSummary preview={stage.preview} mobile={mobile} />
                <p className="m-0 mt-3 text-xs text-text-subtle">You can undo it right after.</p>
              </>
            )}
          </>
        )}
        {stage?.kind === "done" && <p role="status" className="m-0 text-text-2">{stage.text}</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        {stage?.kind === "done" ? (
          <>
            {stage.undoId && (
              <Button variant="ghost" size="sm" disabled={stage.busy} onClick={() => void undo(stage.undoId!)}>Undo</Button>
            )}
            <Button size="sm" onClick={close}>Close</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
            {onFork && (
              <Button variant="outline" size="sm" disabled={stage?.kind !== "preview" || stage.busy || nothing} onClick={() => void confirm(true)}>
                Rewind and fork
              </Button>
            )}
            <Button variant="destructive" size="sm" disabled={stage?.kind !== "preview" || stage.busy || nothing} onClick={() => void confirm(false)}>
              <History />Rewind code
            </Button>
          </>
        )}
      </div>
    </>
  );

  return (
    <>
      <ActionButton
        icon={<History className="size-3.5" />}
        label="Rewind code"
        title="Put the files back as they were before this message"
        onClick={() => void start()}
      />
      {mobile ? (
        <BottomSheet open={!!stage} onClose={close} className="flex max-h-[90%] flex-col gap-3 overflow-y-auto px-4 pt-4">
          <div data-testid="rewind-code-dialog" className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-semibold">Rewind code to here?</h2>
            <p className="m-0 text-sm text-muted-foreground">{intro}</p>
            {body}
          </div>
        </BottomSheet>
      ) : (
        <Dialog open={!!stage} onOpenChange={(open) => { if (!open) close(); }}>
          <DialogContent className="sm:max-w-[460px]" data-testid="rewind-code-dialog">
            <DialogHeader>
              <DialogTitle>Rewind code to here?</DialogTitle>
              <DialogDescription>{intro}</DialogDescription>
            </DialogHeader>
            {body}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
