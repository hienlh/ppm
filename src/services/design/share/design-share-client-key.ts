import { isIP } from "node:net";
import { getShareTunnelAddress } from "./design-share-address.ts";

/**
 * Which client a reviewer's request is counted against, for the share routes' rate limits.
 *
 * `CF-Connecting-IP` is believed only when the request came through PPM's own tunnel: the
 * peer is loopback (cloudflared, or the supervisor's edge forwarder, runs on this machine)
 * and `Host` is the tunnel's public hostname (cached by the address helper, so no file is
 * read per request). Cloudflare's edge sets that header itself; anywhere else it is
 * whatever the client wrote. Every other request is keyed by its peer address, and loopback
 * peers share one key, `"local"` — behind the supervisor that is every LAN and Tailscale
 * reviewer at once, which the budgets are sized for.
 *
 * A LAN client can forge both headers and so pick its own key. The per-link caps ignore the
 * key, and the limiter keeps a bounded number of keys, so that buys a forger nothing.
 */

export const LOCAL_CLIENT_KEY = "local";

/** Test seam: where the current public tunnel URL comes from. */
export const clientKeyDeps = { tunnelUrl: (): string | null => getShareTunnelAddress().url };

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

/** The public tunnel's host (`name.example.com`), lower-cased, or null when there is none. */
function tunnelHost(): string | null {
  const url = clientKeyDeps.tunnelUrl();
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function shareClientKey(input: ClientKeyInput): string {
  const peer = peerAddress(input.env, input.req);
  if (!peer) return LOCAL_CLIENT_KEY;
  if (!isLoopbackAddress(peer)) return `ip:${peer}`;
  const forwarded = input.cfConnectingIp?.trim();
  const host = input.host?.trim().toLowerCase();
  if (forwarded && host && isIP(forwarded) && host === tunnelHost()) return `cf:${forwarded.toLowerCase()}`;
  return LOCAL_CLIENT_KEY;
}
