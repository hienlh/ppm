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
import { turnSecretScrubber } from "../vault/turn-secret-scrubber.ts";
import { BOT_TOKEN_RE, botFileUrl, botMethodUrl, scrubToken } from "./telegram-api-base.ts";
import { splitTelegramHtml, stripTelegramHtml } from "./telegram-html-format.ts";
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
const UPLOAD_TIMEOUT_MS = 60_000;
/** Telegram's own limits: 10 MB a photo, 2 to 10 items in one album, 1024 characters of caption. */
export const MAX_TELEGRAM_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_TELEGRAM_ALBUM = 10;
export const MAX_TELEGRAM_CAPTION = 1024;

/** One picture to upload: its bytes, a file name Telegram shows, and an HTML caption. */
export interface TelegramPhotoUpload {
  bytes: Uint8Array;
  filename: string;
  caption?: string;
}
/** Edit timestamps older than this are dropped once the map grows: the message is long done. */
const EDIT_MEMORY_MS = 60_000;
const EDIT_MEMORY_LIMIT = 500;
/** A path `getFile` returns looks like `photos/file_12.jpg`; anything else is not fetched. */
const FILE_PATH_RE = /^[\w-]+(?:\/[\w.-]+)*$/;


/**
 * Every text PPM sends to Telegram goes through the vault's scrubber: a value of the secure or
 * sealed tier an AI read in the last minutes is replaced by `[vault:<name>]`, whatever chat or
 * relay is sending it. A fallback; the vault's own rules keep those values off Telegram first.
 */
function scrubText(v: string): string {
  if (!turnSecretScrubber.any()) return v;
  // The tag is HTML-safe in a parse_mode HTML message: an item name's own <, > and & are dropped.
  return turnSecretScrubber.scrub(v).replace(/\[vault:([^\]]*)\]/g, (_m, n: string) => `[vault:${n.replace(/[<>&]/g, "")}]`);
}

function withoutVaultValues(body: Record<string, unknown>): Record<string, unknown> {
  if (!turnSecretScrubber.any()) return body;
  let out = body;
  for (const key of ["text", "caption"] as const) {
    const v = out[key];
    if (typeof v !== "string") continue;
    const scrubbed = scrubText(v);
    if (scrubbed !== v) out = { ...out, [key]: scrubbed };
  }
  return out;
}

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
    options: { replyMarkup?: InlineKeyboardMarkup; replyTo?: number; silent?: boolean } = {},
  ): Promise<TelegramCallResult<TelegramMessage>> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      ...(options.replyTo ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } } : {}),
      // Delivered without a sound or vibration: the message is there, the phone stays still.
      ...(options.silent ? { disable_notification: true } : {}),
    });
  }

  /**
   * Upload pictures: one as `sendPhoto`, two to ten as one album (`sendMediaGroup`), each with its
   * own HTML caption. Resolves with the messages Telegram made. A caption Telegram cannot parse
   * is not retried as plain text here: the caller writes captions from escaped text only.
   */
  sendPhotos(
    chatId: number | string,
    photos: TelegramPhotoUpload[],
    options: { silent?: boolean } = {},
  ): Promise<TelegramCallResult<TelegramMessage[]>> {
    if (photos.length === 0 || photos.length > MAX_TELEGRAM_ALBUM) {
      return Promise.resolve({ ok: false, errorCode: 400, description: `between 1 and ${MAX_TELEGRAM_ALBUM} photos per call` });
    }
    if (photos.some((p) => p.bytes.byteLength > MAX_TELEGRAM_PHOTO_BYTES)) {
      return Promise.resolve({ ok: false, errorCode: 400, description: "photo larger than 10 MB" });
    }
    // Cut where a tag or an entity is whole and closed again, never mid-`&amp;`: Telegram refuses
    // a caption it cannot parse, and the picture with it. Scrubbed of vault values first, so the
    // cut never splits one.
    const caption = (c?: string) => {
      const cut = c ? splitTelegramHtml(scrubText(c), MAX_TELEGRAM_CAPTION)[0] : undefined;
      return cut ? { caption: cut, parse_mode: "HTML" } : {};
    };
    const form = (): FormData => {
      const f = new FormData();
      f.set("chat_id", String(chatId));
      if (options.silent) f.set("disable_notification", "true");
      if (photos.length === 1) {
        const p = photos[0]!;
        f.set("photo", new Blob([new Uint8Array(p.bytes)], { type: "image/png" }), p.filename);
        const c = caption(p.caption);
        if (c.caption) { f.set("caption", c.caption); f.set("parse_mode", "HTML"); }
        return f;
      }
      f.set("media", JSON.stringify(photos.map((p, i) => ({ type: "photo", media: `attach://photo${i}`, ...caption(p.caption) }))));
      photos.forEach((p, i) => f.set(`photo${i}`, new Blob([new Uint8Array(p.bytes)], { type: "image/png" }), p.filename));
      return f;
    };
    const method = photos.length === 1 ? "sendPhoto" : "sendMediaGroup";
    return this.upload<TelegramMessage | TelegramMessage[]>(method, form).then((res) =>
      res.ok ? { ok: true as const, result: Array.isArray(res.result) ? res.result : [res.result] } : res);
  }

  /** A multipart call, with the same single 429 wait as {@link call}. */
  private async upload<T>(method: string, form: () => FormData): Promise<TelegramCallResult<T>> {
    const once = async (): Promise<TelegramCallResult<T>> => {
      try {
        const res = await fetch(botMethodUrl(this.token, method), {
          method: "POST", body: form(), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        let json: TelegramApiResult<T>;
        try { json = (await res.json()) as TelegramApiResult<T>; } catch {
          return { ok: false, errorCode: res.status, description: `not a Bot API answer (HTTP ${res.status})` };
        }
        if (json.ok) return { ok: true, result: json.result as T };
        return {
          ok: false, errorCode: json.error_code ?? res.status, description: json.description ?? "no description",
          ...(json.parameters?.retry_after !== undefined ? { retryAfter: json.parameters.retry_after } : {}),
        };
      } catch (e) {
        return this.networkFailure(method, e);
      }
    };
    let res = await once();
    if (!res.ok && res.errorCode === 429 && res.retryAfter !== undefined && res.retryAfter <= this.maxRetryAfterS) {
      log.warn(`${method} rate-limited: retrying in ${res.retryAfter}s`);
      await this.sleep(res.retryAfter * 1000);
      res = await once();
    }
    if (!res.ok && res.errorCode !== null) log.warn(`${method} failed: ${res.errorCode} ${res.description}`);
    return res;
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
    body = withoutVaultValues(body);
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
