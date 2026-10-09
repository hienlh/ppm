import { readSessionHistory } from "../chat-history-read.service.ts";
import type { ChatEvent, ChatMessage } from "../../types/chat.ts";
import type { AssistantSessionTarget } from "./assistant-project-scope.ts";
import { clip } from "./assistant-tool-output.ts";

/**
 * One page of a chat's messages as the Assistant reads them — `chat_read_messages` and
 * `ui_read_tab` on a chat tab — the newest that fit, oldest first, each one's text cut and
 * the tools it called named. The caller has already proven the session is the project's.
 */

const MAX_MESSAGE_CHARS = 4_000;
/** What the messages of one answer may take, leaving room in the answer for the rest. */
const MESSAGE_BUDGET_BYTES = 40 * 1024;

const toolNames = (events: ChatEvent[] | undefined): string[] =>
  [...new Set((events ?? []).flatMap((e) => (e.type === "tool_use" ? [e.tool] : [])))];

function messageView(m: ChatMessage) {
  const tools = toolNames(m.events);
  return {
    role: m.role,
    at: m.timestamp || null,
    text: clip(m.content ?? "", MAX_MESSAGE_CHARS),
    ...(tools.length ? { tools } : {}),
  };
}

export type ChatMessageView = ReturnType<typeof messageView>;

export interface ChatPage {
  /** Index of the first message returned; read further back with `before: start`. */
  start: number;
  total: number;
  messages: ChatMessageView[];
}

export async function readChatPage(
  target: AssistantSessionTarget,
  opts: { limit: number; before?: number },
): Promise<ChatPage> {
  const page = await readSessionHistory(target.providerId, target.sessionId, {
    limit: opts.limit, ...(opts.before !== undefined ? { before: opts.before } : {}),
  });
  // Keep the newest messages that fit; the oldest ones of the page are left for the next call.
  const messages: ChatMessageView[] = [];
  let bytes = 0;
  for (let i = page.messages.length - 1; i >= 0; i--) {
    const view = messageView(page.messages[i]!);
    bytes += Buffer.byteLength(JSON.stringify(view));
    if (bytes > MESSAGE_BUDGET_BYTES && messages.length > 0) break;
    messages.unshift(view);
  }
  return { start: page.start + (page.messages.length - messages.length), total: page.total, messages };
}
