/**
 * The Telegram Bot API in miniature, for tests that must not reach api.telegram.org. Point PPM
 * at it with `PPM_TELEGRAM_API_BASE=<fake.url>`.
 *
 * It answers the methods PPM calls the way the Bot API documents them
 * (https://core.telegram.org/bots/api): long-polled `getUpdates` that returns as soon as an
 * update exists or the timeout runs out, an `offset` that confirms everything before it,
 * `allowed_updates` remembered between calls, a second poll ending the first with 409, message
 * ids counted per chat, and the refusals PPM has to survive — HTML it cannot parse, a message
 * over 4096 characters, `callback_data` over 64 bytes, a URL button Telegram cannot open (anything
 * but https on a public host: `BUTTON_URL_INVALID`), an edit that changes nothing, deleting a
 * message that is not there. A test plays the person on the other end with `pushText` (an old
 * `date` makes a backlog message, `forward_origin` a forwarded one), `pushPhoto` and
 * `pressButton` (`stale` presses a button the message showed once, as a phone still drawing an
 * old keyboard does).
 */
import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
  TelegramUser,
} from "../../src/services/telegram/telegram-types.ts";

export const FAKE_BOT_TOKEN = `987654321:${"F".repeat(35)}`;

export interface FakeTelegramCall {
  method: string;
  body: Record<string, unknown>;
  /** The error code this call was refused with, when it was. */
  failed?: number;
}

/** A message the bot sent, as it stands now, with every text it had before. */
export interface FakeSentMessage {
  message_id: number;
  chat_id: number;
  text: string;
  parse_mode?: string;
  reply_markup?: InlineKeyboardMarkup;
  reply_to?: number;
  /** Earlier texts, oldest first. */
  history: string[];
}

export interface FakeFailure {
  code: 429 | 400 | 401 | 403 | 409 | 500;
  description?: string;
  retryAfter?: number;
}

export interface FakeTelegram {
  url: string;
  token: string;
  bot: TelegramUser;
  calls: FakeTelegramCall[];
  /** Commands the bot registered with `setMyCommands`. */
  commands: Array<{ command: string; description: string }>;
  /** `answerCallbackQuery` calls, in order. */
  answers: Array<{ callback_query_id: string; text?: string }>;
  /** Messages the bot deleted, as they were when deleted. They are gone from `sent`. */
  deleted: FakeSentMessage[];
  /** `extra` is merged into the message: `date` (seconds) for a backlog message, `forward_origin`. */
  pushText(chatId: number, userId: number, text: string, chatType?: TelegramMessage["chat"]["type"], extra?: Record<string, unknown>): TelegramUpdate;
  pushPhoto(chatId: number, userId: number, options?: { bytes?: Uint8Array; caption?: string; chatType?: TelegramMessage["chat"]["type"] }): TelegramUpdate;
  /**
   * Press a button the bot put under one of its messages; throws if there is no such button.
   * With `stale`, a button the message showed at any point counts, taken away since or not.
   */
  pressButton(chatId: number, userId: number, messageId: number, data: string, options?: { stale?: boolean }): TelegramUpdate;
  sent(chatId: number): FakeSentMessage[];
  lastText(chatId: number): string | undefined;
  buttons(chatId: number, messageId: number): InlineKeyboardButton[][];
  waitFor<T>(predicate: () => T | undefined | null | false, ms?: number): Promise<T>;
  /** Refuse the next call to `method` with this error. Queued: two calls queue two refusals. */
  failNext(method: string, failure: FakeFailure): void;
  stop(): void;
}

const ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "span", "tg-spoiler",
  "a", "code", "pre", "blockquote", "tg-emoji",
]);
const MESSAGE_MAX = 4096;
const CALLBACK_DATA_MAX = 64;

/**
 * Telegram's HTML parse mode, strictly enough to catch what makes it refuse a message: an
 * unknown tag, a bare `<` or `&`, an unknown entity, tags that cross or stay open. Returns the
 * visible text, or the error description Telegram would give.
 */
export function parseTelegramHtml(html: string): { text: string } | { error: string } {
  const stack: string[] = [];
  let text = "";
  let i = 0;
  const fail = (what: string) => ({ error: `Bad Request: can't parse entities: ${what} at byte offset ${Buffer.byteLength(html.slice(0, i))}` });
  while (i < html.length) {
    const c = html[i]!;
    if (c === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) return fail("Unclosed start tag");
      const tag = /^<(\/?)([a-zA-Z][\w-]*)((?:\s+[a-zA-Z-]+(?:="[^"<]*"|='[^'<]*')?)*)\s*>$/.exec(html.slice(i, end + 1));
      if (!tag) return fail(`Unsupported start tag "${html.slice(i + 1, Math.min(end, i + 20))}"`);
      const name = tag[2]!.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return fail(`Unsupported start tag "${name}"`);
      if (tag[1]) {
        if (stack.pop() !== name) return fail(`Can't find end tag corresponding to start tag "${name}"`);
      } else {
        stack.push(name);
      }
      i = end + 1;
    } else if (c === "&") {
      const entity = /^&(lt|gt|amp|quot|#\d+|#x[0-9a-fA-F]+);/.exec(html.slice(i));
      if (!entity) return fail("Character entity expected");
      const e = entity[1]!;
      text += e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"'
        : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      i += entity[0].length;
    } else {
      text += c;
      i++;
    }
  }
  if (stack.length) return fail(`Can't find end tag corresponding to start tag "${stack.at(-1)}"`);
  return { text };
}

const PRIVATE_HOST = /^(?:localhost|.*\.localhost|.*\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[.*\]|\d+(?:\.\d+){3})$/i;

/** A URL a phone could open from a button: https on a public, dotted host name. */
function openableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname.includes(".") && !PRIVATE_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

function checkMarkup(markup: unknown): string | null {
  if (markup === undefined) return null;
  const rows = (markup as InlineKeyboardMarkup)?.inline_keyboard;
  if (!Array.isArray(rows) || !rows.every(Array.isArray)) return "Bad Request: field \"inline_keyboard\" must be an Array of Array";
  for (const button of rows.flat()) {
    if (typeof button?.text !== "string" || !button.text) return "Bad Request: text buttons are unallowed in the inline keyboard";
    if (button.callback_data !== undefined && Buffer.byteLength(button.callback_data) > CALLBACK_DATA_MAX) return "Bad Request: BUTTON_DATA_INVALID";
    if (button.callback_data === undefined && button.url === undefined) return "Bad Request: can't parse inline keyboard button: InlineKeyboardButton must have exactly one optional field";
    if (button.url !== undefined && (typeof button.url !== "string" || !openableUrl(button.url))) return "Bad Request: BUTTON_URL_INVALID";
  }
  return null;
}

export function startFakeTelegram(options: { token?: string; username?: string; port?: number } = {}): FakeTelegram {
  const token = options.token ?? FAKE_BOT_TOKEN;
  const bot: TelegramUser = { id: Number(token.split(":")[0]), is_bot: true, first_name: "PPM", username: options.username ?? "ppm_fake_bot" };
  const calls: FakeTelegramCall[] = [];
  const commands: FakeTelegram["commands"] = [];
  const answers: FakeTelegram["answers"] = [];
  const deleted: FakeSentMessage[] = [];
  const failures = new Map<string, FakeFailure[]>();
  const messages = new Map<number, FakeSentMessage[]>();
  const nextMessageId = new Map<number, number>();
  const files = new Map<string, { path: string; bytes: Uint8Array }>();
  const openQueries = new Set<string>();
  /** Every `callback_data` each message has shown, by `<chat>:<message id>`, for a stale press. */
  const everShown = new Map<string, Set<string>>();
  const remember = (m: FakeSentMessage) => {
    const key = `${m.chat_id}:${m.message_id}`;
    const seen = everShown.get(key) ?? new Set<string>();
    for (const b of m.reply_markup?.inline_keyboard.flat() ?? []) if (b.callback_data) seen.add(b.callback_data);
    everShown.set(key, seen);
  };
  let updates: TelegramUpdate[] = [];
  let nextUpdateId = 1;
  let nextFile = 1;
  let nextQuery = 1;
  let allowedUpdates: string[] | null = null;
  /** The long poll waiting for an update, if any; a new update or a new poll ends it. */
  let waiting: { wake: (conflict: boolean) => void } | null = null;

  const messageId = (chatId: number) => {
    const id = (nextMessageId.get(chatId) ?? 0) + 1;
    nextMessageId.set(chatId, id);
    return id;
  };
  const userOf = (userId: number): TelegramUser => ({ id: userId, is_bot: false, first_name: `User${userId}`, username: `user${userId}` });
  const chatOf = (chatId: number, type: TelegramMessage["chat"]["type"]): TelegramMessage["chat"] =>
    type === "private" ? { id: chatId, type, first_name: `User${chatId}` } : { id: chatId, type, title: `Group ${chatId}` };

  const enqueue = (update: Omit<TelegramUpdate, "update_id">): TelegramUpdate => {
    const full = { update_id: nextUpdateId++, ...update } as TelegramUpdate;
    updates.push(full);
    waiting?.wake(false);
    return full;
  };

  const ok = (result: unknown) => Response.json({ ok: true, result });
  const refuse = (code: number, description: string, extra: Record<string, unknown> = {}) =>
    Response.json({ ok: false, error_code: code, description, ...extra }, { status: code });

  const botMessage = (m: FakeSentMessage): TelegramMessage => ({
    message_id: m.message_id,
    from: bot,
    chat: chatOf(m.chat_id, "private"),
    date: Math.floor(Date.now() / 1000),
    text: m.text,
    ...(m.reply_markup ? { reply_markup: m.reply_markup } : {}),
  });

  const find = (chatId: unknown, id: unknown) => messages.get(Number(chatId))?.find((m) => m.message_id === Number(id));

  /** Validated text of a send or an edit: the visible text, or the refusal to answer with. */
  const textOf = (body: Record<string, unknown>): { text: string } | { error: string } => {
    if (typeof body.text !== "string" || !body.text.trim()) return { error: "Bad Request: message text is empty" };
    const parsed = body.parse_mode === "HTML" ? parseTelegramHtml(body.text) : { text: body.text };
    if ("error" in parsed) return parsed;
    if (parsed.text.length > MESSAGE_MAX) return { error: "Bad Request: message is too long" };
    if (!parsed.text.trim()) return { error: "Bad Request: message text is empty" };
    return parsed;
  };

  async function pollUpdates(body: Record<string, unknown>): Promise<Response> {
    if (Array.isArray(body.allowed_updates)) allowedUpdates = body.allowed_updates.map(String);
    const offset = Number(body.offset ?? 0);
    const timeoutS = Number(body.timeout ?? 0);
    const deliverable = () => {
      // Confirmed updates are gone for good, and so are types this bot did not ask for.
      updates = updates.filter((u) => u.update_id >= offset);
      updates = updates.filter((u) => !allowedUpdates || allowedUpdates.some((t) => t in u));
      return updates.slice(0, Number(body.limit ?? 100));
    };
    if (deliverable().length || timeoutS <= 0) return ok(deliverable());

    // Only one reader per bot: a new poll ends the one already waiting with 409.
    waiting?.wake(true);
    const conflict = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutS * 1000);
      const me = { wake: (c: boolean) => finish(c) };
      function finish(c: boolean) {
        clearTimeout(timer);
        if (waiting === me) waiting = null;
        resolve(c);
      }
      waiting = me;
    });
    if (conflict) return refuse(409, "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running");
    return ok(deliverable());
  }

  function handle(method: string, body: Record<string, unknown>): Response | Promise<Response> {
    switch (method) {
      case "getMe":
        return ok(bot);
      case "getUpdates":
        return pollUpdates(body);
      case "sendMessage": {
        const chatId = Number(body.chat_id);
        if (!Number.isFinite(chatId)) return refuse(400, "Bad Request: chat not found");
        const text = textOf(body);
        if ("error" in text) return refuse(400, text.error);
        const markupError = checkMarkup(body.reply_markup);
        if (markupError) return refuse(400, markupError);
        const replyTo = (body.reply_parameters as { message_id?: number } | undefined)?.message_id;
        const sent: FakeSentMessage = {
          message_id: messageId(chatId),
          chat_id: chatId,
          text: text.text,
          ...(typeof body.parse_mode === "string" ? { parse_mode: body.parse_mode } : {}),
          ...(body.reply_markup ? { reply_markup: body.reply_markup as InlineKeyboardMarkup } : {}),
          ...(replyTo ? { reply_to: replyTo } : {}),
          history: [],
        };
        messages.set(chatId, [...(messages.get(chatId) ?? []), sent]);
        remember(sent);
        return ok(botMessage(sent));
      }
      case "editMessageText": {
        const message = find(body.chat_id, body.message_id);
        if (!message) return refuse(400, "Bad Request: message to edit not found");
        const text = textOf(body);
        if ("error" in text) return refuse(400, text.error);
        const markupError = checkMarkup(body.reply_markup);
        if (markupError) return refuse(400, markupError);
        const markup = body.reply_markup as InlineKeyboardMarkup | undefined;
        if (text.text === message.text && JSON.stringify(markup) === JSON.stringify(message.reply_markup)) {
          return refuse(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
        }
        message.history.push(message.text);
        message.text = text.text;
        // Like Telegram, an edit without a keyboard takes the old one away.
        if (markup) message.reply_markup = markup;
        else delete message.reply_markup;
        remember(message);
        return ok(botMessage(message));
      }
      case "editMessageReplyMarkup": {
        const message = find(body.chat_id, body.message_id);
        if (!message) return refuse(400, "Bad Request: message to edit not found");
        const markupError = checkMarkup(body.reply_markup);
        if (markupError) return refuse(400, markupError);
        const markup = body.reply_markup as InlineKeyboardMarkup | undefined;
        const next = markup && markup.inline_keyboard.length ? markup : undefined;
        if (JSON.stringify(next) === JSON.stringify(message.reply_markup)) {
          return refuse(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
        }
        if (next) message.reply_markup = next;
        else delete message.reply_markup;
        remember(message);
        return ok(botMessage(message));
      }
      case "deleteMessage": {
        const message = find(body.chat_id, body.message_id);
        if (!message) return refuse(400, "Bad Request: message to delete not found");
        const chatId = Number(body.chat_id);
        messages.set(chatId, (messages.get(chatId) ?? []).filter((m) => m !== message));
        deleted.push(message);
        return ok(true);
      }
      case "answerCallbackQuery": {
        const id = String(body.callback_query_id ?? "");
        if (!openQueries.delete(id)) return refuse(400, "Bad Request: query is too old and response timeout expired or query ID is invalid");
        answers.push({ callback_query_id: id, ...(typeof body.text === "string" ? { text: body.text } : {}) });
        return ok(true);
      }
      case "sendChatAction":
        return ok(true);
      case "setMyCommands":
        commands.splice(0, commands.length, ...((body.commands as FakeTelegram["commands"]) ?? []));
        return ok(true);
      case "getFile": {
        const file = files.get(String(body.file_id ?? ""));
        if (!file) return refuse(400, "Bad Request: invalid file_id");
        return ok({ file_id: body.file_id, file_unique_id: `u-${body.file_id}`, file_size: file.bytes.byteLength, file_path: file.path });
      }
      default:
        return refuse(404, "Not Found");
    }
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    // A long poll holds the request open for its whole timeout.
    idleTimeout: 120,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(path);
      if (file) {
        if (file[1] !== token) return new Response("Unauthorized", { status: 401 });
        const found = [...files.values()].find((f) => f.path === file[2]);
        return found ? new Response(new Blob([found.bytes as Uint8Array<ArrayBuffer>])) : new Response("Not Found", { status: 404 });
      }
      const route = /^\/bot([^/]+)\/(\w+)$/.exec(path);
      if (!route) return refuse(404, "Not Found");
      const method = route[2]!;
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        try {
          body = ((await req.json()) ?? {}) as Record<string, unknown>;
        } catch {
          return refuse(400, "Bad Request: invalid JSON");
        }
      }
      const call: FakeTelegramCall = { method, body };
      calls.push(call);
      if (route[1] !== token) {
        call.failed = 401;
        return refuse(401, "Unauthorized");
      }
      const failure = failures.get(method)?.shift();
      if (failure) {
        call.failed = failure.code;
        const description = failure.description ?? (
          failure.code === 429 ? `Too Many Requests: retry after ${failure.retryAfter ?? 1}`
            : failure.code === 400 ? "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0"
              : "Injected failure");
        return refuse(failure.code, description, failure.code === 429 ? { parameters: { retry_after: failure.retryAfter ?? 1 } } : {});
      }
      const res = await handle(method, body);
      if (!res.ok) call.failed = res.status;
      return res;
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    bot,
    calls,
    commands,
    answers,
    deleted,
    pushText(chatId, userId, text, chatType = "private", extra = {}) {
      const message = {
        message_id: messageId(chatId),
        from: userOf(userId),
        chat: chatOf(chatId, chatType),
        date: Math.floor(Date.now() / 1000),
        text,
        ...extra,
      } as TelegramMessage;
      return enqueue({ message });
    },
    pushPhoto(chatId, userId, { bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), caption, chatType = "private" } = {}) {
      // Telegram sends every size it made, smallest first; the last is the original.
      const n = nextFile++;
      const sizes: TelegramPhotoSize[] = [["thumb", 90, 90], ["full", 1280, 720]].map(([kind, w, h]) => {
        const fileId = `photo-${n}-${kind}`;
        files.set(fileId, { path: `photos/file_${n}_${kind}.jpg`, bytes });
        return { file_id: fileId, file_unique_id: `u-${fileId}`, width: w as number, height: h as number, file_size: bytes.byteLength };
      });
      const message: TelegramMessage = {
        message_id: messageId(chatId),
        from: userOf(userId),
        chat: chatOf(chatId, chatType),
        date: Math.floor(Date.now() / 1000),
        photo: sizes,
        ...(caption ? { caption } : {}),
      };
      return enqueue({ message });
    },
    pressButton(chatId, userId, messageId, data, { stale = false } = {}) {
      const message = find(chatId, messageId);
      if (!message) throw new Error(`no bot message ${messageId} in chat ${chatId}`);
      const showing = message.reply_markup?.inline_keyboard.flat().some((b) => b.callback_data === data) ?? false;
      if (!showing && !(stale && everShown.get(`${chatId}:${messageId}`)?.has(data))) {
        throw new Error(`message ${messageId} in chat ${chatId} has no button with data ${JSON.stringify(data)}`);
      }
      const id = `cbq-${nextQuery++}`;
      openQueries.add(id);
      return enqueue({
        callback_query: { id, from: userOf(userId), message: botMessage(message), chat_instance: `ci-${chatId}`, data },
      });
    },
    sent: (chatId) => messages.get(chatId) ?? [],
    lastText: (chatId) => messages.get(chatId)?.at(-1)?.text,
    buttons: (chatId, messageId) => find(chatId, messageId)?.reply_markup?.inline_keyboard ?? [],
    async waitFor(predicate, ms = 3000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`fake Telegram: condition not met within ${ms} ms`);
        await Bun.sleep(10);
      }
    },
    failNext(method, failure) {
      failures.set(method, [...(failures.get(method) ?? []), failure]);
    },
    stop() {
      waiting?.wake(false);
      void server.stop(true);
    },
  };
}
