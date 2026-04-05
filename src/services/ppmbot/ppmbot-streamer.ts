import type { ChatEvent, ResultSubtype } from "../../types/chat.ts";
import type { PPMBotTelegram } from "./ppmbot-telegram.ts";
import {
  markdownToTelegramHtml,
  chunkMessage,
  escapeHtml,
} from "./ppmbot-formatter.ts";

const MAX_MSG_LEN = 4096;
const TYPING_REFRESH_MS = 4000;
const EVENT_TIMEOUT_MS = 60_000; // 60s max wait per event
const PLACEHOLDER = "\u2026"; // ellipsis

/**
 * Wrap an async iterable with per-event timeout.
 * If .next() doesn't resolve within timeoutMs, yields a timeout error.
 */
async function* withEventTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await Promise.race([
        iterator.next(),
        new Promise<{ done: true; value: undefined; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined, timedOut: true }), timeoutMs),
        ),
      ]);
      if ("timedOut" in result) {
        throw new Error("No response within 60 seconds");
      }
      if (result.done) break;
      yield result.value;
    }
  } finally {
    iterator.return?.();
  }
}

export interface StreamConfig {
  showToolCalls: boolean;
  showThinking: boolean;
}

export interface StreamResult {
  contextWindowPct?: number;
  resultSubtype?: ResultSubtype;
  messageIds: number[];
  newSessionId?: string;
}

/**
 * Segments of accumulated response.
 * - "md" = raw markdown from AI (needs conversion)
 * - "html" = pre-formatted HTML (tool calls, thinking, errors — already escaped)
 */
type Segment = { type: "md"; text: string } | { type: "html"; text: string };

/** Render segments into Telegram HTML */
function renderSegments(segments: Segment[]): string {
  return segments
    .map((s) => (s.type === "md" ? markdownToTelegramHtml(s.text) : s.text))
    .join("");
}

/** Check if segments have meaningful content */
function hasContent(segments: Segment[]): boolean {
  return segments.some((s) => s.text.trim().length > 0);
}

/** Get raw text length (approximation for split decisions) */
function segmentsLength(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + s.text.length, 0);
}

/** Append markdown text — merges into last segment if also md */
function appendMd(segments: Segment[], text: string): void {
  const last = segments[segments.length - 1];
  if (last?.type === "md") {
    last.text += text;
  } else {
    segments.push({ type: "md", text });
  }
}

/** Append pre-formatted HTML */
function appendHtml(segments: Segment[], html: string): void {
  segments.push({ type: "html", html: html } as any);
  // fix: use correct field
  segments[segments.length - 1] = { type: "html", text: html };
}

export async function streamToTelegram(
  chatId: number | string,
  events: AsyncIterable<ChatEvent>,
  telegram: PPMBotTelegram,
  config: StreamConfig,
): Promise<StreamResult> {
  const result: StreamResult = { messageIds: [] };
  const segments: Segment[] = [];
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

  const editCurrent = async (): Promise<void> => {
    if (!currentMsgId || !hasContent(segments)) return;

    const html = renderSegments(segments);
    if (html.length > MAX_MSG_LEN) {
      // Finalize current message with what fits, start new one
      await telegram.editMessageFinal(chatId, currentMsgId, html.slice(0, MAX_MSG_LEN));
      currentMsgId = null;

      const overflow = html.slice(MAX_MSG_LEN);
      if (overflow.trim()) {
        const chunks = chunkMessage(overflow, MAX_MSG_LEN);
        for (const chunk of chunks) {
          const sent = await telegram.sendMessage(chatId, chunk);
          if (sent) {
            currentMsgId = sent.message_id;
            result.messageIds.push(currentMsgId);
          }
        }
      }
      // Reset segments — only keep any un-rendered text
      segments.length = 0;
      return;
    }

    await telegram.editMessage(chatId, currentMsgId, html);
  };

  // Process event stream with per-event timeout
  try {
    for await (const event of withEventTimeout(events, EVENT_TIMEOUT_MS)) {
      await refreshTyping();

      switch (event.type) {
        case "text": {
          appendMd(segments, event.content);
          await editCurrent();
          break;
        }

        case "thinking": {
          if (config.showThinking && event.content) {
            appendHtml(segments, `\n<i>💭 ${escapeHtml(event.content)}</i>\n`);
            await editCurrent();
          }
          break;
        }

        case "tool_use": {
          if (config.showToolCalls) {
            const toolName = event.tool;
            const inputPreview = formatToolInput(event.input);
            appendHtml(
              segments,
              `\n🔧 <code>${escapeHtml(toolName)}</code>(${escapeHtml(inputPreview)})\n`,
            );
            await editCurrent();
          }
          break;
        }

        case "tool_result": {
          if (config.showToolCalls && event.isError) {
            appendHtml(
              segments,
              `\n⚠️ <code>${escapeHtml(event.output.slice(0, 200))}</code>\n`,
            );
            await editCurrent();
          }
          break;
        }

        case "error": {
          appendHtml(segments, `\n\n❌ <b>Error:</b> ${escapeHtml(event.message)}`);
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
          appendHtml(
            segments,
            `\n⏳ <i>Switching account: ${escapeHtml(event.reason)}</i>\n`,
          );
          await editCurrent();
          break;
        }

        default:
          break;
      }
    }
  } catch (err) {
    appendHtml(
      segments,
      `\n\n❌ <b>Stream error:</b> ${escapeHtml((err as Error).message)}`,
    );
  }

  // Final edit with complete content
  if (currentMsgId && hasContent(segments)) {
    const html = renderSegments(segments);
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
  } else if (currentMsgId && !hasContent(segments)) {
    await telegram.editMessageFinal(
      chatId,
      currentMsgId,
      "<i>No response generated.</i>",
    );
  }

  return result;
}

// ── Helpers ─────────────────────────────────────────────────────

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
