import type { Json } from "../mcp-http-endpoint.ts";
import { CHAT_DELETE_TOOL, CHAT_STOP_TOOL } from "../../shared/assistant-chat-tool-names.ts";
import { chatDeleteSummary, chatStopSummary, type PinState } from "./assistant-approval-summary-chat.ts";
import { isRunning, resolveChat, resolveChatIn, type ChatTarget, type ChatToolDeps } from "./assistant-chat-tool-target.ts";
import { projectRoute } from "./assistant-route-rules.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * `chat_stop` and `chat_delete`: find the chat in its project, refuse what must not happen before
 * asking, build the card from PPM's records, ask, look again (the answer can come much later), and
 * only then act — the stop through the same code PPM's Stop button runs, the delete through the
 * route the session list calls, which stops a running turn first and deletes nothing if it will
 * not stop.
 */

const cardInput = (chat: ChatTarget) => ({ project: chat.project.name, sessionId: chat.sessionId });

export async function chatStop(ctx: ToolContext, args: Record<string, unknown>, deps: ChatToolDeps): Promise<Json> {
  const found = await resolveChat(args, deps);
  if (!found.ok) return errorResult(found.error);
  const chat = found.value;
  const control = deps.control();
  if (!control) return errorResult("Stopping chats is not available in this PPM process.");
  const shown = control.liveState(chat.sessionId);
  if (!shown?.running) return errorResult(`"${chat.name}" is not running a turn; there is nothing to stop.`);

  const verdict = await ctx.ask({
    tool: CHAT_STOP_TOOL,
    input: cardInput(chat),
    summary: chatStopSummary({
      project: chat.project.name, sessionId: chat.sessionId, title: chat.facts.title, providerId: chat.providerId,
      ...(shown.runningSince !== undefined ? { runningSince: shown.runningSince } : {}),
      backgroundWork: await deps.backgroundWork(chat.sessionId),
    }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(CHAT_STOP_TOOL, verdict, { sessionId: chat.sessionId });

  // Only the turn the card showed: it may have ended, and another begun, while the card waited.
  const now = control.liveState(chat.sessionId);
  if (!now?.running || now.turnId !== shown.turnId || now.runningSince !== shown.runningSince) {
    return errorResult("Not stopped (stale): the turn the card showed ended while the card waited. Nothing was stopped; check chats_attention and ask again if the chat is still running.");
  }
  if (!control.cancelTurn(chat.sessionId, "assistant")) return errorResult("Not stopped: the chat is no longer open in PPM.");
  return jsonResult({ outcome: "stopped", sessionId: chat.sessionId, note: "The stop was sent. What the chat already wrote stays." });
}

function pinState(chat: ChatTarget, deps: ChatToolDeps): PinState {
  if (chat.facts.pinned) return { pinned: true };
  const at = deps.unpins.unpinnedAt(chat.sessionId, deps.now());
  return at === null ? { pinned: false } : { pinned: false, unpinnedByAssistantAt: at };
}

function deleteRefusal(chat: ChatTarget): string | null {
  if (chat.facts.manager) return `"${chat.name}" is the project's manager chat. The user ends that role in PPM's session list; the Assistant does not delete it.`;
  if (chat.facts.branched) return `"${chat.name}" has edited versions branched from it; deleting it would orphan them.`;
  return null;
}

export async function chatDelete(ctx: ToolContext, args: Record<string, unknown>, deps: ChatToolDeps): Promise<Json> {
  const found = await resolveChat(args, deps);
  if (!found.ok) return errorResult(found.error);
  const chat = found.value;
  const refusal = deleteRefusal(chat);
  if (refusal) return errorResult(`Not deleted: ${refusal}`);
  const running = isRunning(deps, chat.sessionId);

  const verdict = await ctx.ask({
    tool: CHAT_DELETE_TOOL,
    input: cardInput(chat),
    summary: chatDeleteSummary({
      project: chat.project.name, sessionId: chat.sessionId, title: chat.facts.title, providerId: chat.providerId,
      pin: pinState(chat, deps), running,
    }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(CHAT_DELETE_TOOL, verdict, { sessionId: chat.sessionId });

  // The card named this chat as it stood: deleted, moved, pinned, made a manager or started
  // since, it is no longer what the user approved.
  const again = await resolveChatIn(chat.project, chat.sessionId, deps);
  if (!again.ok) return errorResult(`Not deleted: ${again.error}`);
  const now = again.value;
  const stale = deleteRefusal(now)
    ?? (now.facts.pinned !== chat.facts.pinned ? `"${chat.name}" was ${now.facts.pinned ? "pinned" : "unpinned"} while the card waited.` : null)
    ?? (!running && isRunning(deps, chat.sessionId) ? `"${chat.name}" started a turn while the card waited.` : null);
  if (stale) return errorResult(`Not deleted: ${stale} Ask again if it should still go.`);

  const r = await ctx.callRoute("DELETE", projectRoute(chat.project.name, `chat/sessions/${encodeURIComponent(chat.sessionId)}`, {
    stopRunning: 1, providerId: chat.providerId,
  }));
  if (!r.ok) return errorResult(`Not deleted (PPM answered ${r.status}): ${r.error ?? "no reason given"}`);
  deps.unpins.forget(chat.sessionId);
  return jsonResult({ outcome: "deleted", sessionId: chat.sessionId, ...(running ? { note: "Its running turn was stopped first." } : {}) });
}
