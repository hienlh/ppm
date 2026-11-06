import { ApiError } from "./api-client";

/**
 * Whether an /api/upgrade/apply failure actually means "the server is
 * restarting", not "the upgrade failed". The self-replace tears the server down
 * mid-request, so the response often never arrives cleanly: the connection
 * drops (TypeError), or a proxy/tunnel in front returns a gateway page while the
 * origin is briefly gone (a non-JSON 502/503/504, or Cloudflare's 52x).
 *
 * Decided by what came back, never by what the message says. An answer in PPM's
 * own JSON means PPM was up and the upgrade failed, whatever its status, and its
 * message is the installer's output ("npm ERR! network request to … failed"):
 * words like "network" or "fetch" there say nothing about the connection.
 */
export function looksLikeServerRestart(e: unknown): boolean {
  if (e instanceof ApiError) {
    if (e.body != null) return false; // PPM's own JSON: it was up, and it said no
    // Not JSON: a proxy/tunnel's page. 502/503/504 + Cloudflare 520–529.
    return e.status === 502 || e.status === 503 || e.status === 504 || (e.status >= 520 && e.status <= 529);
  }
  return e instanceof TypeError; // no response at all: dropped connection / fetch failure
}
