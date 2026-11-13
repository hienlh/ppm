import { isLoopbackAddress, peerAddress } from "../../services/design/share/design-share-client-key.ts";

/**
 * Whether a request for the CLI's identity proof came straight from a program on this machine.
 *
 * The peer address alone cannot say so: cloudflared, Tailscale's proxy and the supervisor's edge
 * forwarder all connect from loopback. So, building on how `design-share-client-key.ts` reads a
 * tunnel request, four things are checked:
 * - The peer is a loopback address (a LAN client reaching an unsupervised server directly is not).
 * - No browser header: a page fetching `127.0.0.1:<port>` sends `Origin` or `Sec-Fetch-*`; the
 *   CLI's `fetch` sends neither.
 * - No proxy header: cloudflared adds `CF-Connecting-IP`, `CF-Ray` and `X-Forwarded-For`,
 *   Tailscale's proxy `Tailscale-User-*` and `X-Forwarded-*`; others use `Forwarded` or `Via`.
 * - Not the port the edge forwarder relays the network to. The edge pipes raw TCP and adds no
 *   header, so a LAN client reaching it looks exactly like the CLI; a supervised server therefore
 *   answers the CLI on a loopback listener of its own (`cli-hello-listener.ts`) and marks its
 *   main port here.
 */

const PROXY_HEADERS = ["forwarded", "via", "x-real-ip", "true-client-ip", "cdn-loop"];
const PROXY_PREFIXES = ["x-forwarded-", "cf-", "tailscale-"];
const BROWSER_PREFIXES = ["sec-fetch-"];

/** Ports whose traffic comes through the edge forwarder: the proof is never given out on them. */
const edgeForwardedPorts = new Set<number>();

export function markEdgeForwardedPort(port: number): void {
  if (Number.isInteger(port) && port > 0) edgeForwardedPorts.add(port);
}

/** Test seam. */
export function _resetEdgeForwardedPorts(): void {
  edgeForwardedPorts.clear();
}

/** The port the request arrived on, from the server Hono runs under (`c.env`); null when unknown. */
export function requestArrivalPort(env: unknown): number | null {
  const port = env && typeof env === "object" ? Number((env as { port?: unknown }).port) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** Why this request may not be given the proof, or null when it may. */
export function cliHelloRefusal(req: Request, env: unknown): string | null {
  const names = [...req.headers.keys()].map((n) => n.toLowerCase());
  if (names.includes("origin") || names.some((n) => BROWSER_PREFIXES.some((p) => n.startsWith(p)))) {
    return "Answered only to the ppm command line, not to a web page";
  }
  if (names.some((n) => PROXY_HEADERS.includes(n) || PROXY_PREFIXES.some((p) => n.startsWith(p)))) {
    return "Answered only to a direct request from this machine, not through a tunnel or proxy";
  }
  const peer = peerAddress(env, req);
  if (!peer || !isLoopbackAddress(peer)) return "Answered only to a request from this machine";
  const port = requestArrivalPort(env);
  if (port !== null && edgeForwardedPorts.has(port)) {
    return "Not answered on the port the network reaches; the ppm command line asks this server's own loopback port";
  }
  return null;
}
