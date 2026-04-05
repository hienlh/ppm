import type { ChatEvent, ResultSubtype } from "../../types/chat.ts";
import type { ClawBotTelegram } from "./clawbot-telegram.ts";
import {
  markdownToTelegramHtml,
  chunkMessage,
  escapeHtml,
} from "./clawbot-formatter.ts";

const MAX_MSG_LEN = 4096;
const TYPING_REFRESH_MS = 4000;
const PLACEHOLDER = "\u2026"; // ellipsis

export interface StreamConfig {
  showToolCalls: boolean;
  showThinking: boolean;
}

export interface StreamResult {
  contextWindowPct?: number;
  resultSubtype?: ResultSubtype;
  /** All Telegram message IDs sent during this stream */
  messageIds: number[];
  /** New session ID if session was migrated */
  newSessionId?: string;
}

/**
 * Consume a ChatEvent stream and progressively send/edit Telegram messages.
 *
 * Flow:
 * 1. Send placeholder message
 * 2. Accumulate text/tool/thinking events
 * 3. Edit message every time ClawBotTelegram allows (1s throttle)
 * 4. When text exceeds 4096, finalize current msg, start new one
 * 5. On done/error, finalize and return result
 */
export async function streamToTelegram(
  chatId: number | string,
  events: AsyncIterable<ChatEvent>,
  telegram: ClawBotTelegram,
  config: StreamConfig,
): Promise<StreamResult> {
  const result: StreamResult = { messageIds: [] };
  let accumulated = "";
  let currentMsgId: number | null = null;
  let lastTypingTime = 0;

  const refreshTyping = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastTypingTime >= TYPING_REFRESH_MS) {
      lastTypingTime = now;
      await telegram.sendTyping(chatId);
    }
  };

  // Send placeholder
  await telegram.sendTyping(chatId);
  lastTypingTime = Date.now();
  const placeholder = await telegram.sendMessage(chatId, PLACEHOLDER);
  if (placeholder) {
    currentMsgId = placeholder.message_id;
    result.messageIds.push(currentMsgId);
  }

  const finalizeAndStartNew = async (text: string): Promise<void> => {
    if (currentMsgId && text.trim()) {
      const html = markdownToTelegramHtml(text);
      await telegram.editMessageFinal(chatId, currentMsgId, html);
    }
    accumulated = "";
    currentMsgId = null;
  };

  const sendNewMessage = async (text: string): Promise<void> => {
    const html = markdownToTelegramHtml(text);
    const chunks = chunkMessage(html, MAX_MSG_LEN);
    for (const chunk of chunks) {
      const sent = await telegram.sendMessage(chatId, chunk);
      if (sent) {
        currentMsgId = sent.message_id;
        result.messageIds.push(currentMsgId);
      }
    }
  };

  const editCurrent = async (): Promise<void> => {
    if (!currentMsgId || !accumulated.trim()) return;

    const html = markdownToTelegramHtml(accumulated);
    if (html.length > MAX_MSG_LEN) {
      const splitPoint = findSplitPoint(accumulated, MAX_MSG_LEN * 0.8);
      const first = accumulated.slice(0, splitPoint);
      const rest = accumulated.slice(splitPoint).trimStart();

      await finalizeAndStartNew(first);
      accumulated = rest;
      if (rest) {
        await sendNewMessage(rest);
      }
      return;
    }

    await telegram.editMessage(chatId, currentMsgId, html);
  };

  // Process event stream
  try {
    for await (const event of events) {
      await refreshTyping();

      switch (event.type) {
        case "text": {
          accumulated += event.content;
          await editCurrent();
          break;
        }

        case "thinking": {
          if (config.showThinking && event.content) {
            accumulated += `\n<i>${escapeHtml(event.content)}</i>\n`;
            await editCurrent();
          }
          break;
        }

        case "tool_use": {
          if (config.showToolCalls) {
            const toolName = event.tool;
            const inputPreview = formatToolInput(event.input);
            accumulated += `\n🔧 <code>${escapeHtml(toolName)}</code>(${escapeHtml(inputPreview)})\n`;
            await editCurrent();
          }
          break;
        }

        case "tool_result": {
          if (config.showToolCalls && event.isError) {
            accumulated += `\n⚠️ <code>${escapeHtml(event.output.slice(0, 200))}</code>\n`;
            await editCurrent();
          }
          break;
        }

        case "error": {
          accumulated += `\n\n❌ <b>Error:</b> ${escapeHtml(event.message)}`;
          await editCurrent();
          break;
        }

        case "done": {
          result.contextWindowPct = event.contextWindowPct;
          result.resultSubtype = event.resultSubtype;
          break;
        }

        case "session_migrated": {
          result.newSessionId = event.newSessionId;
          break;
        }

        case "account_retry": {
          accumulated += `\n⏳ <i>Switching account: ${escapeHtml(event.reason)}</i>\n`;
          await editCurrent();
          break;
        }

        default:
          // Ignore unknown events (system, team_detected, account_info, etc.)
          break;
      }
    }
  } catch (err) {
    accumulated += `\n\n❌ <b>Stream error:</b> ${escapeHtml((err as Error).message)}`;
  }

  // Final edit with complete content
  if (currentMsgId && accumulated.trim()) {
    const html = markdownToTelegramHtml(accumulated);
    const chunks = chunkMessage(html, MAX_MSG_LEN);

    if (chunks.length === 1) {
      await telegram.editMessageFinal(chatId, currentMsgId, chunks[0]!);
    } else {
      await telegram.editMessageFinal(chatId, currentMsgId, chunks[0]!);
      for (let i = 1; i < chunks.length; i++) {
        const sent = await telegram.sendMessage(chatId, chunks[i]!);
        if (sent) result.messageIds.push(sent.message_id);
      }
    }
  } else if (currentMsgId && !accumulated.trim()) {
    await telegram.editMessageFinal(
      chatId,
      currentMsgId,
      "<i>No response generated.</i>",
    );
  }

  return result;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Format tool input for compact display */
function formatToolInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input.slice(0, 80);

  try {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "";

    if ("command" in obj) return String(obj.command).slice(0, 80);
    if ("file_path" in obj) return String(obj.file_path).slice(0, 80);
    if ("pattern" in obj) return String(obj.pattern).slice(0, 80);
    if ("query" in obj) return String(obj.query).slice(0, 80);
    if ("url" in obj) return String(obj.url).slice(0, 80);

    const firstKey = keys[0]!;
    return `${firstKey}=${String(obj[firstKey]).slice(0, 60)}`;
  } catch {
    return "";
  }
}

/**
 * Find a good split point in text, aiming for targetLen.
 * Prefers double newline > single newline > space.
 */
function findSplitPoint(text: string, targetLen: number): number {
  if (text.length <= targetLen) return text.length;

  const window = text.slice(0, Math.floor(targetLen));

  let point = window.lastIndexOf("\n\n");
  if (point > targetLen * 0.3) return point;

  point = window.lastIndexOf("\n");
  if (point > targetLen * 0.3) return point;

  point = window.lastIndexOf(" ");
  if (point > targetLen * 0.3) return point;

  return Math.floor(targetLen);
}
