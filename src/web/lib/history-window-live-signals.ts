/**
 * What the live list says that the history window has to act on while it covers it: a message
 * this tab just sent (the window gives way to the live list, so the sender sees it), and a
 * question the agent is waiting on (the window shows it above the composer, so it can be answered
 * without leaving).
 *
 * Both read only the tail of the list: everything they look for is in the running turn, and the
 * list is new on every streamed token.
 */
import type { ChatMessage } from "../../types/chat";
import { ASYNC_QUESTION_TOOL, questionReplyPrefix, type ChatQuestion } from "../../shared/chat-questions";

/**
 * The id of the newest user message when this tab sent it, else null. A message this tab sends
 * is added with its `clientId` as its id (`use-chat.ts`); one another device sent arrives with an
 * id of its own, and a history copy has no `clientId` at all.
 */
export function lastLocalSendId(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    return m.clientId && m.id === m.clientId ? m.id : null;
  }
  return null;
}

export interface PendingAsyncQuestion {
  itemId: string;
  questions: ChatQuestion[];
}

/** A question the agent asked in the running turn (after the newest user message) and nobody has answered. */
export function pendingAsyncQuestion(messages: readonly ChatMessage[]): PendingAsyncQuestion | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") return null;
    if (m.role !== "assistant" || !m.events) continue;
    for (let j = m.events.length - 1; j >= 0; j--) {
      const ev = m.events[j]!;
      if (ev.type !== "tool_use" || ev.tool !== ASYNC_QUESTION_TOOL || ev.parentToolUseId || !ev.toolUseId) continue;
      const questions = (ev.input as { questions?: ChatQuestion[] } | undefined)?.questions;
      if (!Array.isArray(questions) || questions.length === 0) continue;
      const prefix = questionReplyPrefix(ev.toolUseId);
      if (messages.some((r) => r.role === "user" && r.content.startsWith(prefix))) return null;
      return { itemId: ev.toolUseId, questions };
    }
  }
  return null;
}
