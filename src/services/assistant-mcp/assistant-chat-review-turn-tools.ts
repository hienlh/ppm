import type { Json } from "../mcp-http-endpoint.ts";
import { CHAT_CHANGES_ANSWER_TOOL } from "../../shared/assistant-chat-tool-names.ts";
import type { SessionAnswerResult, TurnRevertResult } from "../../shared/session-file-changes.ts";
import { findTurn } from "../session-file-baselines/session-turn-calls.ts";
import { reviewRevertTurnSummary, reviewUndoSummary } from "./assistant-approval-summary-review.ts";
import { cardChat, readTurns, reviewRoute } from "./assistant-chat-review-read.ts";
import type { ChatTarget, ChatToolDeps } from "./assistant-chat-tool-target.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * `chat_changes_answer` with `revert_turn` and `undo`. A turn is named by its number and turned into
 * its calls by the same grouping the chat uses; the route previews what reverting them would do, the
 * card shows that preview, and the approval applies exactly it — at the versions it was worked out
 * against, so a file touched since makes the route write nothing at all (`stale`). An undo's card
 * names the files from the answer's own journal.
 */

const failure = (what: string, r: { status: number; error?: string }) => errorResult(`${what} (PPM answered ${r.status}): ${r.error ?? "no reason given"}`);

export async function reviewRevertTurn(ctx: ToolContext, chat: ChatTarget, args: Record<string, unknown>): Promise<Json> {
  const n = args.turn;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return errorResult("`turn` must be a turn's number from chat_changes.");
  const turns = await readTurns(ctx, chat);
  if (typeof turns === "string") return errorResult(turns);
  const turn = findTurn(turns, n);
  if (typeof turn === "string") return errorResult(turn);
  if (turn.calls.length === 0) return errorResult(`Turn ${n} made no tool calls; there is nothing of it to put back.`);

  const preview = await ctx.callRoute<TurnRevertResult>("POST", reviewRoute(chat, "/revert-turn"), { calls: turn.calls });
  if (!preview.ok || !preview.data) return failure("Could not work out the turn's revert", preview);
  const files = preview.data.files;
  if (!files.some((f) => f.action !== "none" && !f.error)) {
    return jsonResult({ outcome: "unchanged", note: `Turn ${n} left nothing that can be put back.`, files });
  }

  const verdict = await ctx.ask({
    tool: CHAT_CHANGES_ANSWER_TOOL,
    input: { project: chat.project.name, sessionId: chat.sessionId, action: "revert_turn", turn: n },
    summary: reviewRevertTurnSummary(cardChat(chat), turn, files),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(CHAT_CHANGES_ANSWER_TOOL, verdict, { sessionId: chat.sessionId, turn: n });

  const applied = await ctx.callRoute<TurnRevertResult>("POST", reviewRoute(chat, "/revert-turn"), {
    calls: turn.calls, apply: files.map((f) => ({ path: f.path, version: f.version })),
  });
  if (!applied.ok || !applied.data) return failure("Not reverted", applied);
  if (applied.data.stale) {
    return errorResult("Not reverted (stale): a file changed since the card was shown; nothing was written. Read chat_changes again and ask again if still needed.");
  }
  return jsonResult({
    outcome: applied.data.undoId ? "reverted" : "unchanged",
    turn: n,
    files: applied.data.files.map((f) => ({ path: f.path, action: f.action, ...(f.skipped.length ? { leftAsTheyAre: f.skipped.length } : {}), ...(f.error ? { error: f.error } : {}) })),
    ...(applied.data.undoId ? { undoId: applied.data.undoId } : {}),
  });
}

export async function reviewUndo(ctx: ToolContext, chat: ChatTarget, args: Record<string, unknown>, deps: ChatToolDeps): Promise<Json> {
  const undoId = args.undoId;
  if (typeof undoId !== "string" || !undoId) return errorResult("`undoId` is required: the one an earlier answer returned.");
  const record = deps.undoRecord(chat.sessionId, undoId);
  if (!record) return errorResult("This chat's review has no answer with that undoId (an answer can be undone for a day).");

  const verdict = await ctx.ask({
    tool: CHAT_CHANGES_ANSWER_TOOL,
    input: { project: chat.project.name, sessionId: chat.sessionId, action: "undo", undoId },
    summary: reviewUndoSummary(cardChat(chat), { undoId, ...record }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(CHAT_CHANGES_ANSWER_TOOL, verdict, { sessionId: chat.sessionId, undoId });

  const r = await ctx.callRoute<SessionAnswerResult>("POST", reviewRoute(chat, "/undo"), { undoId });
  if (!r.ok || !r.data) return failure("Not undone", r);
  if (r.data.stale) return errorResult("Not undone (stale): a file changed since that answer; nothing was put back.");
  return jsonResult({ outcome: "undone", undoId, files: r.data.files.map((f) => ({ path: f.path, ...(f.error ? { error: f.error } : {}) })) });
}
