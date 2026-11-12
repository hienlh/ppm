import type { Json } from "../mcp-http-endpoint.ts";
import { CHAT_CHANGES_ANSWER_TOOL } from "../../shared/assistant-chat-tool-names.ts";
import type { SessionAnswerResult, SessionFileDiff } from "../../shared/session-file-changes.ts";
import { UNATTENDED_TURN_REFUSAL } from "../chat-control/chat-control.ts";
import { reviewKeepSummary, reviewRevertSummary } from "./assistant-approval-summary-review.ts";
import { isCleanTurn } from "./assistant-chat-organize-tool.ts";
import { allFiles, cardChat, pickFile, pickFiles, readReview, reviewRoute, type PickedFile } from "./assistant-chat-review-read.ts";
import { fileReview } from "./assistant-chat-review-diff.ts";
import { reviewRevertTurn, reviewUndo } from "./assistant-chat-review-turn-tools.ts";
import { resolveChat, type ChatTarget, type ChatToolDeps } from "./assistant-chat-tool-target.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * `chat_changes` and `chat_changes_answer`: a chat's file changes as its Review tab shows them, and
 * the Review tab's answers. Keeping marks the agent's edits accepted, which is the user's control
 * over them, so it skips its card only in a clean turn; reopening hands that control back and needs
 * none. Reverting, reverting a turn and undoing write files and always ask. Every answer goes with
 * the versions the tool just read: the route leaves a file that moved since alone, as `stale`.
 */

export async function chatChanges(ctx: ToolContext, args: Record<string, unknown>, deps: ChatToolDeps): Promise<Json> {
  const found = await resolveChat(args, deps);
  if (!found.ok) return errorResult(found.error);
  const chat = found.value;
  const state = await readReview(ctx, chat);
  if (typeof state === "string") return errorResult(state);
  const { turns, files } = state;
  const header = { project: chat.project.name, sessionId: chat.sessionId, title: chat.facts.title };

  if (args.path !== undefined) {
    const file = pickFile(files, chat.project.path, args.path);
    if (typeof file === "string") return errorResult(file);
    const r = await ctx.callRoute<SessionFileDiff>("GET", reviewRoute(chat, "/diff", { path: file.path }));
    if (!r.ok || !r.data) return errorResult(`Could not read the file's changes: ${r.error ?? `PPM answered ${r.status}`}`);
    return jsonResult({
      chat: header, path: file.path, status: file.status, version: file.version,
      added: file.additions ?? null, removed: file.deletions ?? null,
      ...(file.reviewed ? { reviewed: true } : {}), ...(file.sinceReview ? { sinceReview: true } : {}),
      ...fileReview(r.data, turns.turns),
    });
  }

  const listed = files.map((f) => ({
    path: f.path, status: f.status, version: f.version, added: f.additions ?? null, removed: f.deletions ?? null,
    openBlocks: (f.blocks ?? []).filter((b) => !b.kept).length, blocks: f.blocks?.length ?? null,
    ...(f.reviewed ? { reviewed: true } : {}),
  }));
  return jsonResult({
    chat: header,
    files: listed,
    turns: turns.turns.map((t) => ({ n: t.n, ...(t.unnumbered ? { unnumbered: true } : {}), at: t.at, prompt: t.prompt, calls: t.calls.length })),
    ...(turns.total > turns.turns.length ? { olderTurns: `${turns.total - turns.turns.length} older turns cannot be named here` } : {}),
  }, { key: "files", list: listed });
}

/** The answer's outcome, file by file, as the route gave it. */
function answered(action: string, result: SessionAnswerResult): Json {
  const files = result.files.map((f) => ({ path: f.path, ...(f.stale ? { stale: true } : {}), ...(f.error ? { error: f.error } : {}) }));
  const stale = files.filter((f) => f.stale).length;
  return jsonResult({
    outcome: result.undoId ? action : "unchanged",
    files,
    ...(result.undoId ? { undoId: result.undoId } : {}),
    ...(stale ? { note: `${stale} file(s) changed since they were listed and were left alone; read chat_changes again.` } : {}),
  });
}

async function answer(ctx: ToolContext, chat: ChatTarget, kind: "keep" | "open" | "revert", picked: PickedFile[], action: string): Promise<Json> {
  const r = await ctx.callRoute<SessionAnswerResult>("POST", reviewRoute(chat, "/answer"), { answer: kind, files: picked.map((p) => p.answer) });
  if (!r.ok || !r.data) return errorResult(`Nothing was answered (PPM answered ${r.status}): ${r.error ?? "no reason given"}`);
  return answered(action, r.data);
}

async function keepOrReopen(ctx: ToolContext, chat: ChatTarget, args: Record<string, unknown>, keep: boolean): Promise<Json> {
  const state = await readReview(ctx, chat);
  if (typeof state === "string") return errorResult(state);
  const picked = args.files === undefined
    ? allFiles(state, keep ? (f) => !f.reviewed : (f) => !!f.reviewed || !!f.blocks?.some((b) => b.kept))
    : pickFiles(state, chat.project.path, args.files);
  if (typeof picked === "string") return errorResult(picked);
  if (picked.length === 0) return jsonResult({ outcome: "unchanged", note: keep ? "Nothing is left to keep." : "Nothing is kept or reviewed to reopen." });
  if (keep && !isCleanTurn(ctx.provenanceAtCall)) {
    const verdict = await ctx.ask({
      tool: CHAT_CHANGES_ANSWER_TOOL,
      input: { project: chat.project.name, sessionId: chat.sessionId, action: "keep", files: picked.map((p) => p.answer) },
      summary: reviewKeepSummary(cardChat(chat), picked.map((p) => p.card)),
    });
    if (verdict.verdict !== "approved") return notApprovedResult(CHAT_CHANGES_ANSWER_TOOL, verdict, { sessionId: chat.sessionId });
  }
  return answer(ctx, chat, keep ? "keep" : "open", picked, keep ? "kept" : "reopened");
}

async function revert(ctx: ToolContext, chat: ChatTarget, args: Record<string, unknown>): Promise<Json> {
  if (args.files === undefined) return errorResult("`files` is required to revert: name the files (and blocks) from chat_changes.");
  const state = await readReview(ctx, chat);
  if (typeof state === "string") return errorResult(state);
  const picked = pickFiles(state, chat.project.path, args.files);
  if (typeof picked === "string") return errorResult(picked);
  const verdict = await ctx.ask({
    tool: CHAT_CHANGES_ANSWER_TOOL,
    input: { project: chat.project.name, sessionId: chat.sessionId, action: "revert", files: picked.map((p) => p.answer) },
    summary: reviewRevertSummary(cardChat(chat), picked.map((p) => p.card)),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(CHAT_CHANGES_ANSWER_TOOL, verdict, { sessionId: chat.sessionId });
  return answer(ctx, chat, "revert", picked, "reverted");
}

export async function chatChangesAnswer(ctx: ToolContext, args: Record<string, unknown>, deps: ChatToolDeps): Promise<Json> {
  if (deps.unattended(ctx.sessionId)) return errorResult(UNATTENDED_TURN_REFUSAL);
  const found = await resolveChat(args, deps);
  if (!found.ok) return errorResult(found.error);
  const chat = found.value;
  switch (args.action) {
    case "keep": return keepOrReopen(ctx, chat, args, true);
    case "reopen": return keepOrReopen(ctx, chat, args, false);
    case "revert": return revert(ctx, chat, args);
    case "revert_turn": return reviewRevertTurn(ctx, chat, args);
    case "undo": return reviewUndo(ctx, chat, args, deps);
    default: return errorResult("`action` must be keep, reopen, revert, undo or revert_turn.");
  }
}
