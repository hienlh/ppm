/**
 * Where PPM talks to the Telegram Bot API. Every Telegram call in PPM builds its URL here, so a
 * test (or an end-to-end run against a fake Bot API) can point all of them somewhere else with
 * one environment variable.
 *
 * The bot token travels in the URL path, so the override is accepted only for a loopback
 * address: an override that could name another machine would hand that machine the token.
 */
import { createLogger } from "../logger.ts";

const log = createLogger("telegram");

export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_API_BASE_ENV = "PPM_TELEGRAM_API_BASE";

/** What a bot token looks like: `<bot id>:<secret>`. */
export const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,50}$/;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The override's origin when it is `http(s)://<loopback>:<port>` and nothing else — no path,
 * query, credentials or default port — else null. `URL` lowercases the host and keeps IPv6
 * in brackets, which is what the set above compares against.
 */
export function parseLoopbackApiBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (!url.port) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return `${url.protocol}//${url.host}`;
}

/** Warned once per process: the poll loops ask for the base on every call. */
let warnedRejected = false;

/**
 * The Bot API origin to call. Read on every call rather than once, so a test can set and clear
 * the variable around itself. A rejected override falls back to the real API and is reported
 * without its value — whoever set it may have put something private there.
 */
export function telegramApiBase(): string {
  const raw = process.env[TELEGRAM_API_BASE_ENV];
  if (!raw) return DEFAULT_TELEGRAM_API_BASE;
  const base = parseLoopbackApiBase(raw);
  if (base) return base;
  if (!warnedRejected) {
    warnedRejected = true;
    log.warn(`${TELEGRAM_API_BASE_ENV} ignored: only http(s)://127.0.0.1, localhost or [::1] with a port is accepted`);
  }
  return DEFAULT_TELEGRAM_API_BASE;
}

/** URL of a Bot API method. Holds the token: never log it. */
export function botMethodUrl(token: string, method: string): string {
  return `${telegramApiBase()}/bot${token}/${method}`;
}

/** URL of a file `getFile` returned a path for. Holds the token: never log it. */
export function botFileUrl(token: string, filePath: string): string {
  return `${telegramApiBase()}/file/bot${token}/${filePath}`;
}

/**
 * An error message with the token taken out. A fetch failure can quote the URL it was given,
 * and that URL carries the token.
 */
export function scrubToken(message: string, token: string): string {
  return token ? message.split(token).join("[REDACTED]") : message;
}

export function _resetTelegramApiBaseWarningForTests(): void {
  warnedRejected = false;
}
