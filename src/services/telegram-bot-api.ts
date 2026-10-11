/**
 * The few Telegram Bot API calls the notification side needs: checking a token,
 * sending one message, and reading updates while a connect link is open.
 * A bot's chat features go through `telegram/telegram-bot-client.ts` instead.
 */
import { BOT_TOKEN_RE, botMethodUrl, scrubToken } from "./telegram/telegram-api-base.ts";
import type { TelegramApiResult, TelegramUpdate } from "./telegram/telegram-types.ts";

export { BOT_TOKEN_RE };

const REQUEST_TIMEOUT_MS = 10_000;

async function callTelegram<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
): Promise<TelegramApiResult<T>> {
  const res = await fetch(botMethodUrl(token, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return (await res.json()) as TelegramApiResult<T>;
}

export type BotIdentity =
  | { ok: true; username: string }
  | { ok: false; reason: "invalid" | "unreachable"; message: string };

/** Ask Telegram who a token belongs to. Distinguishes a wrong token from no network. */
export async function getBotIdentity(token: string): Promise<BotIdentity> {
  if (!BOT_TOKEN_RE.test(token)) {
    return { ok: false, reason: "invalid", message: "That is not a bot token. It looks like 123456789:AAH… — copy it again from @BotFather." };
  }
  try {
    const json = await callTelegram<{ username?: string }>(token, "getMe", {});
    if (json.ok && json.result?.username) return { ok: true, username: json.result.username };
    return {
      ok: false,
      reason: "invalid",
      message: `Telegram did not accept this token${json.description ? ` (${json.description})` : ""}. Copy it again from @BotFather.`,
    };
  } catch (e) {
    return { ok: false, reason: "unreachable", message: `Could not reach Telegram to check the token: ${scrubToken((e as Error).message, token)}` };
  }
}

export async function sendTelegramMessage(token: string, chatId: string, html: string): Promise<TelegramApiResult<unknown>> {
  return callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

/** Long-poll for messages. `timeoutSeconds` 0 returns at once, which also confirms everything before `offset`. */
export async function getTelegramUpdates(
  token: string,
  offset: number,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<TelegramApiResult<TelegramUpdate[]>> {
  const deadline = AbortSignal.timeout((timeoutSeconds + 10) * 1000);
  return callTelegram<TelegramUpdate[]>(
    token,
    "getUpdates",
    { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
    signal ? AbortSignal.any([signal, deadline]) : deadline,
  );
}
