/**
 * One Telegram bot, as the rest of PPM talks to it: long-polling for messages and button
 * presses, sending and editing HTML messages, inline keyboards, and downloading what a person
 * sent.
 *
 * Telegram's limits are handled here so no caller has to: a 429 is waited out once (Telegram
 * says how long), a message Telegram cannot parse as HTML is resent as plain text rather than
 * lost, and repeated edits of one message are spaced out, because editing a streaming answer on
 * every delta is exactly what draws a 429.
 *
 * The token is in every URL, so nothing here logs a URL or a raw fetch error: a failure is
 * logged as the method, Telegram's error code and its description.
 */
import { createLogger } from "../logger.ts";
import { BOT_TOKEN_RE, botFileUrl, botMethodUrl, scrubToken } from "./telegram-api-base.ts";
import { stripTelegramHtml } from "./telegram-html-format.ts";
import type {
  InlineKeyboardMarkup,
  TelegramApiResult,
  TelegramBotCommand,
  TelegramChatAction,
  TelegramFile,
  TelegramMessage,
  TelegramUpdate,
} from "./telegram-types.ts";

const log = createLogger("telegram");

/** What every call resolves to. `errorCode` is null when Telegram was never reached. */
export type TelegramCallResult<T> =
  | { ok: true; result: T }
  | { ok: false; errorCode: number | null; description: string; retryAfter?: number };

/** An edit skipped because the same message was edited less than the interval ago. */
export type TelegramEditResult = TelegramCallResult<true> | { ok: false; throttled: true };

export interface TelegramBotClientOptions {
  /** Least time between two edits of one message; a `final` edit ignores it. Default 1 s. */
  editIntervalMs?: number;
  /** Longest `retry_after` that is waited out; a longer one fails the call. Default 30 s. */
  maxRetryAfterS?: number;
  /** Per-request deadline for everything but `getUpdates` and downloads. Default 10 s. */
  requestTimeoutMs?: number;
  /** How a wait is slept; tests replace it to avoid real delays. */
  sleep?: (ms: number) => Promise<void>;
}

const UPDATE_TYPES = ["message", "callback_query"] as const;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Edit timestamps older than this are dropped once the map grows: the message is long done. */
const EDIT_MEMORY_MS = 60_000;
const EDIT_MEMORY_LIMIT = 500;
/** A path `getFile` returns looks like `photos/file_12.jpg`; anything else is not fetched. */
const FILE_PATH_RE = /^[\w-]+(?:\/[\w.-]+)*$/;

export class TelegramBotClient {
  private readonly token: string;
  private readonly editIntervalMs: number;
  private readonly maxRetryAfterS: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastEdit = new Map<string, number>();

  constructor(token: string, options: TelegramBotClientOptions = {}) {
    if (!BOT_TOKEN_RE.test(token)) throw new Error("Invalid Telegram bot token format");
    this.token = token;
    this.editIntervalMs = options.editIntervalMs ?? 1000;
    this.maxRetryAfterS = options.maxRetryAfterS ?? 30;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /** The bot's id: the digits before the token's colon. Safe to log. */
  get botId(): string {
    return this.token.slice(0, this.token.indexOf(":"));
  }

  /**
   * Long-poll for messages and button presses. `offset` confirms every update before it.
   * Failures are returned, not logged: the poll loop decides how loudly to report a refusal.
   */
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TelegramCallResult<TelegramUpdate[]>> {
    const deadline = AbortSignal.timeout((timeoutS + 10) * 1000);
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutS, allowed_updates: UPDATE_TYPES },
      { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, quiet: true },
    );
  }

  sendMessage(
    chatId: number | string,
    html: string,
    options: { replyMarkup?: InlineKeyboardMarkup; replyTo?: number } = {},
  ): Promise<TelegramCallResult<TelegramMessage>> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      ...(options.replyTo ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } } : {}),
    });
  }

  /**
   * Replace a message's text. An edit within `editIntervalMs` of the last one to the same
   * message is skipped (`throttled`) — the caller's next edit carries newer text anyway — unless
   * it is `final`, which always goes. "Message is not modified" counts as success: the message
   * already says this.
   */
  async editMessageText(
    chatId: number | string,
    messageId: number,
    html: string,
    options: { replyMarkup?: InlineKeyboardMarkup; final?: boolean } = {},
  ): Promise<TelegramEditResult> {
    const key = `${chatId}:${messageId}`;
    const now = Date.now();
    if (!options.final && now - (this.lastEdit.get(key) ?? -Infinity) < this.editIntervalMs) {
      return { ok: false, throttled: true };
    }
    this.rememberEdit(key, now, options.final === true);
    const res = await this.call<unknown>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    }, { notModifiedIsOk: true });
    return res.ok ? { ok: true, result: true } : res;
  }

  /** Replace the buttons under a message; `null` removes them. */
  async editMessageReplyMarkup(
    chatId: number | string,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup | null,
  ): Promise<TelegramCallResult<true>> {
    const res = await this.call<unknown>("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    }, { notModifiedIsOk: true });
    return res.ok ? { ok: true, result: true } : res;
  }

  /**
   * Delete one of the bot's messages. A message already gone counts as deleted: the caller wanted
   * it gone. Telegram refuses other deletions (a message over 48 hours old, say), and the caller
   * then has to say what the message became some other way.
   */
  async deleteMessage(chatId: number | string, messageId: number): Promise<TelegramCallResult<true>> {
    const res = await this.call<unknown>("deleteMessage", { chat_id: chatId, message_id: messageId }, { goneIsOk: true });
    return res.ok ? { ok: true, result: true } : res;
  }

  /** Stop the spinner on the pressed button; `text` shows as a short toast. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TelegramCallResult<boolean>> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  sendChatAction(chatId: number | string, action: TelegramChatAction = "typing"): Promise<TelegramCallResult<boolean>> {
    return this.call<boolean>("sendChatAction", { chat_id: chatId, action });
  }

  setMyCommands(commands: TelegramBotCommand[]): Promise<TelegramCallResult<boolean>> {
    return this.call<boolean>("setMyCommands", { commands });
  }

  getFile(fileId: string): Promise<TelegramCallResult<TelegramFile>> {
    return this.call<TelegramFile>("getFile", { file_id: fileId });
  }

  /**
   * Download a file `getFile` returned a path for, refusing anything over `maxBytes` — by its
   * declared length when the server sends one, and by counting otherwise, so a lying or absent
   * `Content-Length` cannot make PPM hold more than it agreed to.
   */
  async downloadFile(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<TelegramCallResult<Uint8Array>> {
    if (!FILE_PATH_RE.test(filePath) || filePath.split("/").includes("..")) {
      return { ok: false, errorCode: null, description: "unexpected file path" };
    }
    const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(botFileUrl(this.token, filePath), { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!res.ok) {
        await res.body?.cancel();
        log.warn(`file download failed: ${res.status}`);
        return { ok: false, errorCode: res.status, description: `download failed (${res.status})` };
      }
      const declared = Number(res.headers.get("content-length"));
      if (declared > maxBytes) {
        await res.body?.cancel();
        return { ok: false, errorCode: null, description: "file too large" };
      }
      const parts: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            return { ok: false, errorCode: null, description: "file too large" };
          }
          parts.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
      return { ok: true, result: bytes };
    } catch (e) {
      return this.networkFailure("file download", e, signal?.aborted);
    }
  }

  private rememberEdit(key: string, at: number, final: boolean): void {
    if (final) {
      // The message is finished; nothing will edit it again soon.
      this.lastEdit.delete(key);
      return;
    }
    this.lastEdit.set(key, at);
    if (this.lastEdit.size > EDIT_MEMORY_LIMIT) {
      for (const [k, t] of this.lastEdit) if (at - t > EDIT_MEMORY_MS) this.lastEdit.delete(k);
    }
  }

  /**
   * The one place a Bot API request is made. A 429 within `maxRetryAfterS` is waited out and
   * the call made once more; an HTML message Telegram cannot parse is resent once as the same
   * text without markup, because a message that arrives plain beats one that never arrives.
   */
  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; quiet?: boolean; notModifiedIsOk?: boolean; goneIsOk?: boolean } = {},
  ): Promise<TelegramCallResult<T>> {
    let res = await this.request<T>(method, body, options);

    if (!res.ok && res.errorCode === 429 && res.retryAfter !== undefined && res.retryAfter <= this.maxRetryAfterS) {
      log.warn(`${method} rate-limited: retrying in ${res.retryAfter}s`);
      await this.sleep(res.retryAfter * 1000);
      if (options.signal?.aborted) return res;
      res = await this.request<T>(method, body, options);
    }

    if (!res.ok && res.errorCode === 400 && /can't parse entities/i.test(res.description)
      && body.parse_mode === "HTML" && typeof body.text === "string") {
      log.warn(`${method}: Telegram could not parse the HTML (${res.description}); resending as plain text`);
      const { parse_mode: _drop, ...plain } = body;
      res = await this.request<T>(method, { ...plain, text: stripTelegramHtml(body.text) }, options);
    }

    if (!res.ok && options.notModifiedIsOk && res.errorCode === 400 && /message is not modified/i.test(res.description)) {
      return { ok: true, result: true as T };
    }
    if (!res.ok && options.goneIsOk && res.errorCode === 400 && /message to delete not found/i.test(res.description)) {
      return { ok: true, result: true as T };
    }
    if (!res.ok && !options.quiet && res.errorCode !== null) {
      log.warn(`${method} failed: ${res.errorCode} ${res.description}`);
    }
    return res;
  }

  private async request<T>(
    method: string,
    body: Record<string, unknown>,
    { signal, quiet }: { signal?: AbortSignal; quiet?: boolean },
  ): Promise<TelegramCallResult<T>> {
    try {
      const res = await fetch(botMethodUrl(this.token, method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(this.requestTimeoutMs),
      });
      let json: TelegramApiResult<T>;
      try {
        json = (await res.json()) as TelegramApiResult<T>;
      } catch {
        return { ok: false, errorCode: res.status, description: `not a Bot API answer (HTTP ${res.status})` };
      }
      if (json.ok) return { ok: true, result: json.result as T };
      return {
        ok: false,
        errorCode: json.error_code ?? res.status,
        description: json.description ?? "no description",
        ...(json.parameters?.retry_after !== undefined ? { retryAfter: json.parameters.retry_after } : {}),
      };
    } catch (e) {
      return this.networkFailure(method, e, quiet || signal?.aborted);
    }
  }

  /** Telegram was not reached. Logged unless `silent` (cancelled, or a poll that reports for itself); never with the token. */
  private networkFailure(what: string, e: unknown, silent?: boolean): { ok: false; errorCode: null; description: string } {
    const description = scrubToken(e instanceof Error ? e.message : String(e), this.token);
    if (!silent) log.warn(`${what} could not reach Telegram: ${description}`);
    return { ok: false, errorCode: null, description };
  }
}
