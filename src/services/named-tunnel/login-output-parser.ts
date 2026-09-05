/**
 * Pure parsers for `cloudflared tunnel login` stdout/stderr chunks.
 *
 * cloudflared prints the browser URL and progress lines on stderr, not
 * stdout (verified 2026-09-05, cloudflared 2026.3.0) — callers must feed both
 * streams through these functions, never stdout alone.
 */

/** Primary shape: the real dash.cloudflare.com/argotunnel URL cloudflared prints today. */
const PRIMARY_URL = /https:\/\/dash\.cloudflare\.com\/argotunnel\?[^\s]+/;

/** Exact success line cloudflared prints on a successful login, exit code 0. */
const SUCCESS_LINE = /You have successfully logged in\./;

/**
 * Extract the login URL from a stdout/stderr chunk (or accumulated buffer).
 * Falls back to the first `https://` token on any line mentioning
 * "argotunnel" so a cosmetic rename of the URL shape never leaves the flow
 * stuck at `waiting` with no way for the user to open the browser page.
 */
export function extractLoginUrl(text: string): string | null {
  const primary = text.match(PRIMARY_URL);
  if (primary) return primary[0];

  for (const line of text.split(/\r?\n/)) {
    if (!/argotunnel/i.test(line)) continue;
    const fallback = line.match(/https:\/\/[^\s]+/);
    if (fallback) return fallback[0];
  }
  return null;
}

/** True once cloudflared has printed its success line. */
export function isLoginSuccess(text: string): boolean {
  return SUCCESS_LINE.test(text);
}
