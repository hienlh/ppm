import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The reviewer's page shell, the one "no longer valid" page every refusal answers with, and
 * the headers every share response carries.
 *
 * The shell is a separate build, `design-share-page/index.html` inside the web build. It is
 * served only from `/s/<code>`, under its own CSP; the static route refuses its folder, so
 * it can never be opened without that policy. The file is read once per change (mtime and
 * size), not per request.
 */

/** Set on every `/s` response, whatever it is. */
export const SHARE_COMMON_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

/**
 * The shell's policy: its own scripts, styles and API only, the design frame from this
 * origin, and no service worker, manifest, plugin, form target or framing by anyone.
 */
export const GUEST_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/** The invalid page runs nothing; it may show inside the design frame, which is same-origin. */
export const INVALID_PAGE_CSP = [
  "sandbox",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** Same body for every reason a code does not open, so a refusal tells a guest nothing. */
export const INVALID_PAGE_HTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
  + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\">"
  + "<title>Link no longer valid</title>"
  + "<style>body{font:15px/1.5 system-ui,sans-serif;color:#555;background:#fafafa;display:grid;place-items:center;"
  + "min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}"
  + "@media (prefers-color-scheme:dark){body{color:#bbb;background:#161616}}h1{font-size:18px;margin:0 0 8px}</style>"
  + "</head><body><main><h1>This link is no longer valid</h1>"
  + "<p>Ask the person who shared it for a new link.</p></main></body></html>";

/** The JSON form of the same refusal, for the API routes. */
export const INVALID_LINK_MESSAGE = "This link is no longer valid";

export const GUEST_PAGE_DIR = "design-share-page";
const GUEST_PAGE_FILE = "index.html";
/** The shell is a few KB; anything far larger is not the file the build writes. */
const MAX_GUEST_PAGE_BYTES = 1024 * 1024;

let cached: { path: string; mtimeMs: number; size: number; html: string } | null = null;

/** The built shell under `distDir`, or null when it has not been built. */
export async function readGuestPageHtml(distDir: string): Promise<string | null> {
  const path = join(distDir, GUEST_PAGE_DIR, GUEST_PAGE_FILE);
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size > MAX_GUEST_PAGE_BYTES) return null;
  if (cached && cached.path === path && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.html;
  const html = await Bun.file(path).text();
  cached = { path, mtimeMs: info.mtimeMs, size: info.size, html };
  return html;
}
