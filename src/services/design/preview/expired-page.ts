import { BRIDGE_CHANNEL, BRIDGE_NONCE_RE, BRIDGE_VERSION } from "../../../shared/design-bridge-protocol.ts";

/**
 * What the design frame receives instead of the design when its token is dead (expired,
 * unknown, or lost to a server restart).
 *
 * A JSON 404 would do nothing useful: the frame is an opaque origin, so the parent cannot
 * read its contents or tell an error page from a slow design. This page tells the parent
 * itself, with the load's nonce, and the canvas re-mints a token and reloads.
 */

export const EXPIRED_PAGE_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

export function expiredPageHtml(nonce: string | null): string {
  // Only a nonce of the validated shape is ever written into the script, as a JSON literal.
  const safeNonce = nonce && BRIDGE_NONCE_RE.test(nonce) ? nonce : null;
  const message = JSON.stringify({ ppm: BRIDGE_CHANNEL, v: BRIDGE_VERSION, nonce: safeNonce, type: "expired" });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview expired</title>`
    + `<script>try{parent.postMessage(${message},"*")}catch(e){}</script>`
    + `<style>body{font:14px system-ui,sans-serif;color:#666;display:grid;place-items:center;height:100vh;margin:0}</style>`
    + `</head><body><p>This preview has expired. Reopening the design refreshes it.</p></body></html>`;
}
