/**
 * Recognises OAuth authorization URLs that hand their result back to a port on
 * the machine running the CLI, rather than to whatever device opened them.
 *
 * This is what strands a login started from a phone: the sign-in succeeds, the
 * browser is redirected to 127.0.0.1:<port>, and on the phone that address is
 * the phone itself — so the CLI waiting on the real machine never hears back.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1"]);

/** Whether a hostname addresses the machine the browser is running on. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

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

/** Whether a pasted string is a callback this machine could deliver. */
export function isDeliverableCallback(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLoopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}
