/**
 * One log line per HTTP request, so every action taken through the API leaves a trace.
 *
 * `METHOD /path?query STATUS 12ms`, at a level chosen from what happened rather than from the
 * route: a change (POST/PUT/PATCH/DELETE) is INFO, a read is DEBUG, a refused credential is
 * WARN, a server error is ERROR with the error message the response carried — route handlers
 * mostly turn a failure into `c.json(err(e.message), 500)` without logging it, and this is
 * where that message stops disappearing. A handler that threw is logged with its stack.
 *
 * Nothing secret is written: query values of credential-like keys are replaced, and the
 * capability token in a preview or export path is cut out. Bodies are never read, except the
 * (small, JSON or text) body of a 4xx/5xx for its message, and only when the line is written.
 */
import type { MiddlewareHandler } from "hono";
import { createLogger, type LogLevel } from "../../services/logger.ts";

const log = createLogger("http");

/** A request that took this long is worth a WARN on its own. */
export const SLOW_REQUEST_MS = 5_000;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Background writes the UI makes on its own — layout and preference sync, draft autosave, the
 * browser's console beacon, lease pings, warm-ups on every new tab — every few seconds while
 * someone types or drags. They are state sync, not something a person did, and at INFO they
 * would bury the requests that are.
 */
const BACKGROUND_WRITES: readonly RegExp[] = [
  /^\/api\/trace$/,
  /^\/api\/settings\/ui-prefs$/,
  /^\/api\/project\/[^/]+\/workspace$/,
  /^\/api\/project\/[^/]+\/chat\/drafts\//,
  /^\/api\/project\/[^/]+\/chat\/slash-recents$/,
  /^\/api\/project\/[^/]+\/chat\/prewarm$/,
  /^\/api\/project\/[^/]+\/git\/commit-draft$/,
  /^\/api\/system\/resources\/stream\/[^/]+\/ping$/,
  /^\/api\/(codex-)?accounts\/pick$/,
];

/** Paths whose next segment is a bearer capability (a preview or export token, a WHEP ticket). */
const CAPABILITY_PREFIXES = [
  "/api/html-preview/content/",
  "/api/design-preview/content/",
  "/api/db/grid-export/",
  "/api/remote-desktop/whep/",
];

const SECRET_QUERY_KEY = /token|key|secret|password|passwd|auth|code|state|ticket|sig|signature|credential/i;

/**
 * Control characters as visible escapes (`\n`, `\u001b`). A query string arrives decoded — `%0A`
 * is a newline — and an error message can quote input, so either would otherwise end the line
 * early: any client that can reach the port, signed in or not, could add a forged
 * `[time] [ERROR] …` record that `ppm logs` and the Logs window read as PPM's own.
 */
function escapeControlChars(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) =>
    ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function accessLogLevel(method: string, path: string, status: number, ms: number): LogLevel {
  if (status >= 500) return "error";
  if (status === 401 || status === 403) return "warn";
  if (ms >= SLOW_REQUEST_MS) return "warn";
  if (!MUTATING.has(method)) return "debug";
  if (BACKGROUND_WRITES.some((re) => re.test(path))) return "debug";
  return status >= 400 ? "warn" : "info";
}

/** Path + query as logged: capability tokens cut out, credential-like query values replaced. */
export function describeRequestTarget(url: URL): string {
  let path = url.pathname;
  for (const prefix of CAPABILITY_PREFIXES) {
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      path = `${prefix}[token]${slash === -1 ? "" : rest.slice(slash)}`;
      break;
    }
  }
  if (!url.search) return path;
  const parts: string[] = [];
  for (const [k, v] of url.searchParams) {
    parts.push(`${escapeControlChars(k)}=${SECRET_QUERY_KEY.test(k) ? "[REDACTED]" : escapeControlChars(v)}`);
  }
  const target = `${path}?${parts.join("&")}`;
  return target.length > 300 ? `${target.slice(0, 300)}…` : target;
}

/**
 * The message a 4xx/5xx carried: `{ error }` of a JSON body, or the start of a text one. Many
 * handlers turn every exception into a 400/404/409, so without it a server fault logged as a
 * client error says nothing about what went wrong.
 */
async function errorMessageOf(res: Response): Promise<string> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json") && !type.startsWith("text/")) return "";
  try {
    const text = await res.clone().text();
    if (type.includes("json")) {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      const msg = body?.error ?? body?.message;
      if (typeof msg === "string") return msg.slice(0, 500);
    }
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

export const accessLog: MiddlewareHandler = async (c, next) => {
  const started = performance.now();
  await next();
  const ms = Math.round(performance.now() - started);
  const url = new URL(c.req.url);
  const status = c.res.status;
  const level = accessLogLevel(c.req.method, url.pathname, status, ms);
  if (!log.isEnabled(level)) return;
  const line = `${c.req.method} ${describeRequestTarget(url)} ${status} ${ms}ms${ms >= SLOW_REQUEST_MS ? " (slow)" : ""}`;
  // A handler that threw: Hono hands the error to `app.onError` and leaves it on `c.error`.
  // Logged here, with its stack, so the failure and the request it broke are one line.
  if (c.error) return log[level](`${line} —`, c.error);
  const detail = status >= 400 ? escapeControlChars(await errorMessageOf(c.res)) : "";
  log[level](`${line}${detail ? ` — ${detail}` : ""}`);
};
