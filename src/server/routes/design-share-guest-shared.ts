import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { err } from "../../types/api.ts";
import { isDesignError } from "../../services/design/design-error.ts";
import { shareClientKey } from "../../services/design/share/design-share-client-key.ts";
import { GUEST_LINK_CLOSED } from "../../services/design/share/design-share-guest-link.ts";
import {
  INVALID_LINK_MESSAGE, INVALID_PAGE_CSP, INVALID_PAGE_HTML,
} from "../../services/design/share/design-share-guest-page.ts";

/** Responses and request facts every `/s` route shares. */

/** The client this request is counted against (see `design-share-client-key.ts`). */
export function clientKeyOf(c: Context): string {
  return shareClientKey({
    req: c.req.raw, env: c.env, host: c.req.header("host"), cfConnectingIp: c.req.header("cf-connecting-ip"),
  });
}

/** The one page every refused code, and every path that is not a share route, answers with. */
export function invalidPage(): Response {
  return new Response(INVALID_PAGE_HTML, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": INVALID_PAGE_CSP },
  });
}

export function invalidJson(c: Context): Response {
  return c.json(err(INVALID_LINK_MESSAGE), 404);
}

/** 429 with `Retry-After` in whole seconds, at least one. */
export function tooManyRequests(c: Context, retryMs: number): Response {
  const seconds = String(Math.max(1, Math.ceil(retryMs / 1000)));
  return c.json(err("Too many requests; wait a moment and try again"), 429, { "Retry-After": seconds });
}

/** Errors a reviewer causes by naming a file the shared version does not have (or may not serve). */
const MISSING_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "ENAMETOOLONG"]);

function reviewerFileMistake(e: unknown): boolean {
  const raw = e as { code?: unknown; status?: unknown } | null;
  return !!raw && (MISSING_FILE_CODES.has(String(raw.code)) || raw.status === 403 || raw.status === 404);
}

/** An error for the log: its kind, and its message with absolute host paths taken out. */
function describeForLog(e: unknown): string {
  const raw = e as { code?: unknown; name?: unknown; message?: unknown } | null;
  const kind = String(raw?.code ?? raw?.name ?? "Error");
  const message = typeof raw?.message === "string" ? raw.message : String(e);
  return `${kind}: ${message.replace(/(?<![\w.])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"]*/g, "<path>")}`;
}

/**
 * A service refusal as the reviewer sees it: the message and code the comment services
 * wrote for them. A link closed while the write waited answers exactly as a dead code does.
 * A file the reviewer named that the version does not have is their mistake: a 400 and a
 * warning. Anything else is the server's fault and is answered without detail. Nothing
 * logged names the code or a host path, only the link id.
 */
export function guestFail(c: Context, e: unknown, linkId: string): Response {
  if (isDesignError(e) && e.code === GUEST_LINK_CLOSED) return invalidJson(c);
  if (isDesignError(e) && e.status >= 400 && e.status < 500) {
    return c.json({ ...err(e.message), code: e.code }, e.status as ContentfulStatusCode);
  }
  if (reviewerFileMistake(e)) {
    console.warn(`[design-share] ${c.req.method} link=${linkId}: refused a file not in the shared version (${describeForLog(e)})`);
    return c.json({ ...err("That page is not part of the shared version"), code: "EBADFILE" }, 400);
  }
  console.error(`[design-share] ${c.req.method} link=${linkId}: ${describeForLog(e)}`);
  return c.json(err("Something went wrong; try again"), 500);
}

/**
 * The body as text, or null when it is over `maxBytes`. Counted as it arrives, so a body
 * sent without a `Content-Length` is refused without being read to its end.
 */
export async function readCappedText(req: Request, maxBytes: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
