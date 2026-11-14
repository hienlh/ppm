/**
 * Recognises OAuth authorization URLs that hand their result back to a port on
 * the machine running the CLI, rather than to whatever device opened them.
 *
 * This is what strands a login started from another device: the sign-in
 * succeeds, the browser is redirected to 127.0.0.1:<port>, and on that device
 * the address is the device itself — so the CLI waiting on the real machine
 * never hears back.
 *
 * What may be pasted back and delivered is decided in
 * `src/shared/loopback-callback-url.ts`, which the server runs too.
 */
import { isLoopbackHostname, normalizeLoopbackCallback } from "../../shared/loopback-callback-url";

export { isLoopbackHostname, normalizeLoopbackCallback };

/**
 * The loopback port an authorization URL will redirect back to, or null when it
 * redirects somewhere reachable from any device.
 */
export function loopbackRedirectPort(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `redirect_uri` is the OAuth 2.0 name; some tools still send `redirectUri`.
  const redirect =
    parsed.searchParams.get("redirect_uri") ?? parsed.searchParams.get("redirectUri");
  if (!redirect) return null;

  try {
    const target = new URL(redirect);
    if (!isLoopbackHostname(target.hostname)) return null;
    return target.port || (target.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}

/** The distinct loopback ports the logins among these URLs will redirect back to. */
export function loopbackRedirectPorts(urls: readonly string[]): string[] {
  return [...new Set(urls.map(loopbackRedirectPort).filter((p): p is string => !!p))];
}

/** Whether a pasted string is a callback this machine could deliver. */
export function isDeliverableCallback(url: string): boolean {
  return normalizeLoopbackCallback(url).ok;
}
