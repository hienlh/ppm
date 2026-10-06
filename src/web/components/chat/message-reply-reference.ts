import type { ChatMessage } from "../../../types/chat";
import { MAX_REPLY_QUOTE_LENGTH, type ReplyReference } from "../../../shared/chat-reply";
import { parseUserMessage } from "./user-message-parse";

/** Only text visible in the transcript: never thinking, tools or injected context. */
export function replyMessageText(message: ChatMessage): string {
  if (message.role === "assistant") {
    return (message.events?.length
      ? message.events.filter((event) => event.type === "text").map((event) => event.content).join("")
      : message.content).trim();
  }
  if (message.role !== "user") return "";
  const parsed = parseUserMessage(message.content);
  if (parsed.tags.some((tag) => ["task-notification", "environment_details", "local-command-caveat"].includes(tag.name))) return "";
  const parts = [parsed.command?.name, parsed.text].filter(Boolean);
  if (parsed.files.length) parts.push(`Attached files: ${parsed.files.map((path) => path.split(/[\\/]/).pop()).join(", ")}`);
  return parts.join("\n").trim();
}

export function createReplyReference(message: ChatMessage, sessionId: string, providerId: string): ReplyReference | null {
  const text = replyMessageText(message);
  if (!text || message.role === "system" || message.id.startsWith("streaming-")) return null;
  const chars = Array.from(text);
  return { version: 1, sessionId, providerId, messageId: message.id, ...(message.sdkUuid ? { sdkUuid: message.sdkUuid } : {}),
    role: message.role, timestamp: message.timestamp, quote: chars.slice(0, MAX_REPLY_QUOTE_LENGTH).join(""),
    truncated: chars.length > MAX_REPLY_QUOTE_LENGTH };
}

/** A native id still needs its snapshot to match (Codex history ids can be ordinals). */
export function resolveReplyMessage(messages: ChatMessage[], reply: ReplyReference, sessionId?: string, providerId?: string): ChatMessage | null {
  if (reply.sessionId !== sessionId || reply.providerId !== providerId) return null;
  const matchesQuote = (message: ChatMessage) => {
    if (message.role !== reply.role) return false;
    const text = replyMessageText(message);
    return reply.truncated ? Array.from(text).slice(0, MAX_REPLY_QUOTE_LENGTH).join("") === reply.quote : text === reply.quote;
  };
  const native = messages.filter((message) => (
    (reply.sdkUuid && message.sdkUuid === reply.sdkUuid) || (message.id === reply.messageId && message.timestamp === reply.timestamp)) && matchesQuote(message));
  if (native.length === 1) return native[0]!;
  if (native.length > 1) return null;
  const fallback = messages.filter((message) => message.timestamp === reply.timestamp && matchesQuote(message));
  return fallback.length === 1 ? fallback[0]! : null;
}
