/**
 * The chat change tray's half of the session review: where each of a turn's edits stands, and
 * the answers it can give — keep, revert or reopen an edit's blocks, keep the whole turn, and
 * revert the turn from the session's history, each undoable right after.
 *
 * The list is the chat's own (`SessionChangesContext`), so the tray, the changes bar and an open
 * Review tab never disagree; every answer asks for it again.
 */
import { useCallback, useMemo, useState } from "react";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";
import type { SessionTurn } from "@/lib/session-turns";
import {
  answerFiles,
  editReviews,
  turnReviewSummary,
  type EditReview,
  type TurnReviewSummary,
} from "@/lib/turn-review";
import {
  announceReviewMarks,
  answerSessionChanges,
  revertSessionTurn,
  undoSessionAnswer,
} from "@/lib/session-file-changes-client";
import { useSessionChanges } from "@/components/chat/session-changes-context";
import type { SessionAnswer, SessionAnswerResult, TurnRevertResult } from "../../shared/session-file-changes";

/** What the tray says after an answer: what went wrong, or what to undo. */
export interface TurnReviewNotice {
  text: string;
  undoId?: string;
}

export interface TurnReview {
  /** False with no session list to answer against: the tray shows the edits and nothing else. */
  enabled: boolean;
  reviews: ReadonlyMap<string, EditReview>;
  summary: TurnReviewSummary;
  busy: boolean;
  notice: TurnReviewNotice | null;
  dismissNotice: () => void;
  keep: (key: string) => void;
  revert: (key: string) => void;
  /** Open a kept edit again, or undo the revert that took it away. */
  change: (key: string) => void;
  keepAll: () => void;
  /** What reverting the turn would do; null when it could not be worked out (the notice says why). */
  previewRevertTurn: () => Promise<TurnRevertResult | null>;
  /** Revert the turn as previewed; a newer preview when a file moved on since, null once done or failed. */
  applyRevertTurn: (preview: TurnRevertResult) => Promise<TurnRevertResult | null>;
  undo: (undoId: string) => void;
  openReview: (path?: string) => void;
}

const NONE: ReadonlyMap<string, EditReview> = new Map();

function failure(e: unknown): string {
  return e instanceof Error ? e.message : "The change could not be saved.";
}

export function useTurnReview({ changes, turn }: { changes: TurnFileChange[] | undefined; turn: SessionTurn | undefined }): TurnReview {
  const ctx = useSessionChanges();
  const [reverted, setReverted] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<TurnReviewNotice | null>(null);

  const reviews = useMemo(
    () => (ctx && changes ? editReviews(changes, ctx.files, reverted) : NONE),
    [ctx, changes, reverted],
  );
  const summary = useMemo(() => turnReviewSummary(reviews), [reviews]);

  const settle = useCallback(() => {
    if (!ctx) return;
    ctx.refresh();
    // The changes bar asks again on its own; this tells an open Review tab the same.
    announceReviewMarks({ projectName: ctx.projectName, sessionId: ctx.sessionId });
  }, [ctx]);

  /** Run one request; one that may have written reads the list again, whatever it said. */
  const run = useCallback(async <T,>(job: () => Promise<T>, writes = true): Promise<T | null> => {
    setBusy(true);
    try {
      return await job();
    } catch (e) {
      setNotice({ text: failure(e) });
      return null;
    } finally {
      setBusy(false);
      if (writes) settle();
    }
  }, [settle]);

  /** Edits whose blocks an answer about `keys` in `path` reached. */
  const reached = useCallback((path: string, keys: readonly string[]) => {
    const out: string[] = [];
    for (const [key, r] of reviews) if (r.file?.path === path && r.keys.some((k) => keys.includes(k))) out.push(key);
    return out;
  }, [reviews]);

  const answer = useCallback((kind: SessionAnswer, targets: EditReview[], which: "open" | "all") => {
    if (!ctx) return;
    const files = answerFiles(targets, which);
    if (files.length === 0) return;
    void run(async (): Promise<SessionAnswerResult> => {
      const result = await answerSessionChanges(ctx.projectName, ctx.sessionId, kind, files);
      const moved = result.files.filter((f) => f.stale || f.error);
      if (moved.length > 0) {
        setNotice({ text: moved.some((f) => f.stale) ? "A file changed since this was shown. Look again before answering." : moved[0]!.error! });
      }
      if (kind === "revert" && result.undoId) {
        const undoId = result.undoId;
        const blocks = files.reduce((n, f) => n + f.keys.length, 0);
        setReverted((cur) => {
          const next = new Map(cur);
          for (const f of files) for (const key of reached(f.path, f.keys)) next.set(key, undoId);
          return next;
        });
        setNotice({ text: `Reverted ${blocks === 1 ? "1 block" : `${blocks} blocks`}.`, undoId });
      }
      return result;
    });
  }, [ctx, run, reached]);

  const undo = useCallback((undoId: string) => {
    if (!ctx) return;
    void run(async () => {
      const result = await undoSessionAnswer(ctx.projectName, ctx.sessionId, undoId);
      if (result.stale) {
        setNotice({ text: "Nothing was put back: a file changed after the revert." });
        return result;
      }
      setReverted((cur) => new Map([...cur].filter(([, id]) => id !== undoId)));
      setNotice(null);
      return result;
    });
  }, [ctx, run]);

  const at = (key: string) => reviews.get(key);
  const keep = (key: string) => {
    const r = at(key);
    if (r?.state === "open") answer("keep", [r], "open");
  };
  const revert = (key: string) => {
    const r = at(key);
    if (r?.state === "open" || r?.state === "kept") answer("revert", [r], "all");
  };
  const change = (key: string) => {
    const r = at(key);
    if (r?.state === "kept" && r.keys.length > 0) answer("open", [r], "all");
    else if (r?.state === "reverted" && r.undoId) undo(r.undoId);
  };
  const keepAll = () => answer("keep", [...reviews.values()].filter((r) => r.state === "open"), "open");

  const previewRevertTurn = useCallback(async () => {
    if (!ctx || !turn) return null;
    return run(() => revertSessionTurn(ctx.projectName, ctx.sessionId, turn.calls), false);
  }, [ctx, turn, run]);

  const applyRevertTurn = useCallback(async (preview: TurnRevertResult) => {
    if (!ctx || !turn) return null;
    const result = await run(() =>
      revertSessionTurn(ctx.projectName, ctx.sessionId, turn.calls, preview.files.map((f) => ({ path: f.path, version: f.version }))),
    );
    if (!result) return null;
    if (result.stale) return result;
    const failed = result.files.filter((f) => f.error);
    if (result.undoId) {
      const undoId = result.undoId;
      const paths = new Set(result.files.filter((f) => f.action !== "none").map((f) => f.path.replace(/\\/g, "/")));
      setReverted((cur) => {
        const next = new Map(cur);
        for (const [key, r] of reviews) {
          const path = (r.file?.path ?? key.split("\0")[0]!).replace(/\\/g, "/");
          if (paths.has(path)) next.set(key, undoId);
        }
        return next;
      });
    }
    setNotice(
      failed.length > 0
        ? { text: `${failed.length} file${failed.length === 1 ? "" : "s"} could not be written: ${failed[0]!.error}`, ...(result.undoId ? { undoId: result.undoId } : {}) }
        : result.undoId ? { text: "Reverted this turn's changes.", undoId: result.undoId } : { text: "Nothing to put back." },
    );
    return null;
  }, [ctx, turn, run, reviews]);

  return {
    enabled: !!ctx && summary.known > 0,
    reviews,
    summary,
    busy,
    notice,
    dismissNotice: () => setNotice(null),
    keep,
    revert,
    change,
    keepAll,
    previewRevertTurn,
    applyRevertTurn,
    undo,
    openReview: (path) => ctx?.openReview(path),
  };
}
