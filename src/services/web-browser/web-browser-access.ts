/**
 * Who may use PPM's browser, checked by every route and the WS upgrade on its own:
 * the environment switch, the user's on/off answer, PPM authentication (a live browser carrying
 * the host's IP and logins must not inherit "auth disabled = everything open"), same-origin for
 * browser requests, and — when the user turned it off — no request that came through a public
 * tunnel or proxy.
 *
 * Also the single-use connection nonce, the same consume-once pattern as Remote Desktop's.
 */
import { randomUUIDv7 } from "bun";
import { configService } from "../config.service.ts";
import { isWebBrowserAllowedByEnv } from "./web-browser-flag.ts";
import { isPublicTunnelRequest } from "./tunnel-request-guard.ts";
import { getForwardedShareHosts } from "../design/share/design-share-address.ts";
import { parseWebBrowserSettings } from "../../shared/web-browser-settings.ts";

export type AccessRefusal = { status: 403 | 404; code: "disabled" | "auth-required" | "cross-origin" | "public-access"; message: string };

function publicHosts(): string[] {
  try { return getForwardedShareHosts(); } catch { return []; }
}

/** Null when allowed. `requireEnabled` is false for routes that must work before the user decides (capabilities). */
export function checkWebBrowserAccess(req: Request, opts: { requireEnabled?: boolean } = {}): AccessRefusal | null {
  if (!isWebBrowserAllowedByEnv()) return { status: 404, code: "disabled", message: "the web browser is disabled on this host (WEB_BROWSER_ENABLED=0)" };
  if (!configService.get("auth").enabled) {
    return { status: 403, code: "auth-required", message: "the web browser requires PPM authentication to be enabled" };
  }
  const settings = parseWebBrowserSettings(configService.get("web_browser"));
  if ((opts.requireEnabled ?? true) && settings.enabled !== true) {
    return { status: 403, code: "disabled", message: "the web browser is turned off in Settings" };
  }
  const origin = req.headers.get("origin");
  if (origin) {
    // Hostname only, as Remote Desktop compares it: Vite's dev proxy changes the port.
    let a: string | null = null;
    let b: string | null = null;
    try { a = new URL(origin).hostname; } catch {}
    try { b = new URL(req.url).hostname; } catch {}
    if (!a || !b || a !== b) return { status: 403, code: "cross-origin", message: "cross-origin request rejected" };
  }
  if (!settings.allowPublicTunnel && isPublicTunnelRequest(req.headers, req.headers.get("host") ?? undefined, publicHosts())) {
    return { status: 403, code: "public-access", message: "the web browser is turned off for public links in Settings" };
  }
  return null;
}

/** True when the request came through a public tunnel or proxy (for the Settings guard). */
export function isPublicRequest(req: Request): boolean {
  return isPublicTunnelRequest(req.headers, req.headers.get("host") ?? undefined, publicHosts());
}

const NONCE_TTL_MS = 30_000;
const nonces = new Map<string, number>();

export function mintWebBrowserNonce(): string {
  const now = Date.now();
  for (const [n, at] of nonces) if (now - at > NONCE_TTL_MS) nonces.delete(n);
  const nonce = randomUUIDv7();
  nonces.set(nonce, now);
  return nonce;
}

export function consumeWebBrowserNonce(nonce: string): boolean {
  const at = nonces.get(nonce);
  if (at === undefined) return false;
  nonces.delete(nonce);
  return Date.now() - at <= NONCE_TTL_MS;
}
