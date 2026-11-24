/**
 * Whether a request to the in-app browser's routes came in through a public tunnel rather than
 * from the LAN or the tailnet.
 *
 * Behind the supervisor every client reaches the server from loopback, so the peer address says
 * nothing. What does: the headers a proxy adds. Cloudflare adds `CF-*` and `CDN-Loop`, Tailscale
 * Funnel adds `Tailscale-Funnel-Request`, and any other reverse proxy put in front of PPM (ngrok,
 * Caddy, frp) adds `Forwarded`, `Via` or `X-Forwarded-*` — that list is the one
 * `cli-hello-request-guard.ts` uses. `Tailscale-User-*` alone (a tailnet member) is not public.
 * A `Host` naming PPM's own tunnel or share host is public too.
 *
 * A LAN client can add these headers itself; it then only refuses itself.
 */

const PUBLIC_HEADERS = new Set(["forwarded", "via", "x-real-ip", "true-client-ip", "cdn-loop", "tailscale-funnel-request"]);
const PUBLIC_PREFIXES = ["x-forwarded-", "cf-"];

export function isPublicTunnelRequest(headers: Headers, host: string | undefined, publicHosts: string[]): boolean {
  for (const [name] of headers) {
    const lower = name.toLowerCase();
    if (PUBLIC_HEADERS.has(lower) || PUBLIC_PREFIXES.some((p) => lower.startsWith(p))) return true;
  }
  const wanted = host?.trim().toLowerCase();
  return !!wanted && publicHosts.some((h) => h.trim().toLowerCase() === wanted);
}
