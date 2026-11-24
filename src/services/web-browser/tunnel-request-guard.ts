/**
 * Whether a request to the in-app browser's routes came in through a public tunnel rather than
 * from the LAN or the tailnet.
 *
 * Behind the supervisor every client reaches the server from loopback, so the peer address says
 * nothing. What does: the headers a proxy adds. Cloudflare adds `CF-*` and `CDN-Loop`, Tailscale
 * Funnel adds `Tailscale-Funnel-Request`, and any other reverse proxy put in front of PPM (ngrok,
 * Caddy, frp) adds `Forwarded`, `Via` or `X-Forwarded-*` — that list is the one
 * `cli-hello-request-guard.ts` uses. A `Host` naming PPM's own tunnel or share host is public too.
 *
 * Tailscale Serve (the tailnet, not Funnel) also adds `X-Forwarded-*`, next to `Tailscale-User-*`
 * and a `*.ts.net` Host. Those three together, without the Funnel header, are a tailnet member
 * and not public. Requiring the `.ts.net` Host as well keeps a public proxy from passing by
 * merely adding a `Tailscale-User-Login` header.
 *
 * A LAN client can add these headers itself; it then only refuses itself.
 */

const PUBLIC_HEADERS = new Set(["forwarded", "via", "x-real-ip", "true-client-ip", "cdn-loop", "tailscale-funnel-request"]);
const PUBLIC_PREFIXES = ["x-forwarded-", "cf-"];

function hostName(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

/** A request Tailscale Serve brought in from a tailnet member. */
export function isTailnetServeRequest(headers: Headers, host: string | undefined): boolean {
  if (headers.has("tailscale-funnel-request")) return false;
  if ([...headers.keys()].some((n) => n.toLowerCase().startsWith("cf-") || n.toLowerCase() === "cdn-loop")) return false;
  return headers.has("tailscale-user-login") && hostName(host).endsWith(".ts.net");
}

export function isPublicTunnelRequest(headers: Headers, host: string | undefined, publicHosts: string[]): boolean {
  const wanted = host?.trim().toLowerCase();
  if (wanted && publicHosts.some((h) => h.trim().toLowerCase() === wanted)) return true;
  if (isTailnetServeRequest(headers, host)) return false;
  for (const [name] of headers) {
    const lower = name.toLowerCase();
    if (PUBLIC_HEADERS.has(lower) || PUBLIC_PREFIXES.some((p) => lower.startsWith(p))) return true;
  }
  return false;
}
