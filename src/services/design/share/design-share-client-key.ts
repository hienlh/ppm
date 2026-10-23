import { isIP } from "node:net";
import { getForwardedShareHosts } from "./design-share-address.ts";

/**
 * Which client a reviewer's request is counted against, for the share routes' rate limits.
 *
 * `CF-Connecting-IP` is believed only when the request came through a tunnel of this
 * machine's: the peer is loopback (cloudflared, the supervisor's edge forwarder or the share
 * host's worker, all on this machine) and `Host` is one of the public hostnames — PPM's own
 * tunnel or the share host (cached by the address helper, so no file is read per request).
 * Cloudflare's edge sets that header itself; anywhere else it is whatever the client wrote. Every other request is keyed by its peer address, and loopback
 * peers share one key, `"local"` — behind the supervisor that is every LAN and Tailscale
 * reviewer at once, which the budgets are sized for.
 *
 * A LAN client can forge both headers and so pick its own key. The per-link caps ignore the
 * key, and the limiter keeps a bounded number of keys, so that buys a forger nothing.
 */

export const LOCAL_CLIENT_KEY = "local";

/** Test seam: the public hostnames (`host[:port]`, lower-cased) whose tunnels end on this machine. */
export const clientKeyDeps = { publicHosts: (): string[] => getForwardedShareHosts() };

/** What `c.env` holds when Hono runs under `Bun.serve`: the server, which knows the peer. */
interface PeerSource {
  requestIP?: (req: Request) => { address?: unknown } | null;
}

export interface ClientKeyInput {
  req: Request;
  /** Hono's `c.env`; absent when the app is called without a server (tests, `app.request`). */
  env: unknown;
  host: string | undefined;
  cfConnectingIp: string | undefined;
}

function peerAddress(env: unknown, req: Request): string | null {
  const source = env as PeerSource | null | undefined;
  if (!source || typeof source.requestIP !== "function") return null;
  try {
    const address = source.requestIP(req)?.address;
    return typeof address === "string" && isIP(address) ? address : null;
  } catch {
    return null;
  }
}

export function isLoopbackAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return address === "::1" || (isIP(v4) === 4 && v4.startsWith("127."));
}

export function shareClientKey(input: ClientKeyInput): string {
  const peer = peerAddress(input.env, input.req);
  if (!peer) return LOCAL_CLIENT_KEY;
  if (!isLoopbackAddress(peer)) return `ip:${peer}`;
  const forwarded = input.cfConnectingIp?.trim();
  const host = input.host?.trim().toLowerCase();
  if (forwarded && host && isIP(forwarded) && clientKeyDeps.publicHosts().includes(host)) return `cf:${forwarded.toLowerCase()}`;
  return LOCAL_CLIENT_KEY;
}
