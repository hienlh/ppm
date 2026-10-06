/**
 * The local hop between a forward's transport (`tailscale serve`, cloudflared) and a dev
 * server on the host.
 *
 * A dev server started with its defaults is reachable through neither transport as it
 * arrives. Measured with Vite 8: it listens on `[::1]` only, so a transport aimed at
 * `127.0.0.1:<port>` is refused, and it answers any Host that is not localhost with
 * `Blocked request. This host ("….ts.net") is not allowed.` — `tailscale serve` passes the
 * tailnet name through and has no flag to change it. webpack-dev-server and the Angular CLI
 * check Host the same way. So the hop makes each request look as if the browser sat on the
 * host: it dials whichever loopback family is listening and sends `Host: localhost:<port>`.
 *
 * `Origin` and `Referer` are rewritten only when they name the forward's own public origin,
 * i.e. the page the dev server itself served. A dev server's Origin check exists to refuse
 * other sites, and a foreign origin still reaches it unchanged.
 *
 * A page that refuses to be framed is let into PPM's own tab, and still refused by every other
 * site: see frame-ancestors.ts.
 *
 * The hop listens on loopback only, and answers only the Host of its forward's public URL
 * (`setPublicUrl`), with 421 to anything else. Loopback alone does not keep other sites out:
 * a page whose own name resolves to 127.0.0.1 (DNS rebinding) reaches the hop from a browser
 * on the host, and the rewrites above would carry it past the dev server's Host check, which
 * exists to refuse exactly that page.
 */
import type { ServerWebSocket } from "bun";
import { framingOrigins, letOriginsFrame } from "./frame-ancestors.ts";

export type Loopback = "127.0.0.1" | "::1";
/** IPv6 first: the order a browser on the host tries `localhost` in. */
const LOOPBACKS: readonly Loopback[] = ["::1", "127.0.0.1"];

/** Request headers that describe one connection and must not cross the hop. */
const HOP_BY_HOP_REQUEST = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "expect", "host",
  // The request must look local: Next.js compares Origin with X-Forwarded-Host when present.
  "x-forwarded-host", "forwarded",
]);
const HOP_BY_HOP_RESPONSE = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection"];

/** Status codes whose response may not carry a body. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

const WS_CONNECT_TIMEOUT_MS = 10_000;

/** Bun's WebSocket client takes request headers; the DOM typings this project also loads do not know that. */
const UpstreamWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

/** Can a TCP connection to `hostname:port` be opened right now? */
async function canConnect(hostname: Loopback, port: number, timeoutMs = 1000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const socket = await Promise.race([
      Bun.connect({ hostname, port, socket: { data() {}, open(s) { s.end(); }, error() {}, close() {} } }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
    socket.end();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The loopback address a server on `port` answers on; null if neither does. */
export async function listeningLoopback(port: number): Promise<Loopback | null> {
  for (const host of LOOPBACKS) if (await canConnect(host, port)) return host;
  return null;
}

function hostPart(host: Loopback): string {
  return host === "::1" ? "[::1]" : host;
}

/**
 * The headers to send upstream. `publicHost` is the Host the request arrived with, which is
 * the forward's own public host: tailscale serve and cloudflared both pass it through.
 */
export function upstreamRequestHeaders(incoming: Headers, targetPort: number, publicHost: string | null): Headers {
  const local = `http://localhost:${targetPort}`;
  const out = new Headers();
  for (const [name, value] of incoming) {
    if (HOP_BY_HOP_REQUEST.has(name) || name.startsWith("sec-websocket-")) continue;
    out.append(name, value);
  }
  out.set("host", `localhost:${targetPort}`);
  if (publicHost) {
    const own = [`https://${publicHost}`, `http://${publicHost}`];
    const origin = incoming.get("origin");
    if (origin && own.includes(origin)) out.set("origin", local);
    const referer = incoming.get("referer");
    const prefix = referer ? own.find((o) => referer === o || referer.startsWith(`${o}/`)) : undefined;
    if (referer && prefix) out.set("referer", local + referer.slice(prefix.length));
  }
  return out;
}

/** A redirect to the dev server's own local origin, made relative so it stays on the forward. */
export function rewriteLocation(location: string, targetPort: number): string {
  const local = new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${targetPort}(?=[/?#]|$)`, "i");
  if (!local.test(location)) return location;
  const rest = location.replace(local, "");
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/**
 * The response headers to send back, minus what described the upstream connection, and with
 * `framers` (the origins PPM is open at) let through any refusal to be framed.
 */
export function downstreamResponseHeaders(upstream: Headers, targetPort: number, framers: readonly string[] = []): Headers {
  const out = new Headers(upstream);
  for (const name of HOP_BY_HOP_RESPONSE) out.delete(name);
  const location = out.get("location");
  if (location) out.set("location", rewriteLocation(location, targetPort));
  letOriginsFrame(out, framers);
  return out;
}

/** A close code a WebSocket may send; the reserved ones (1005, 1006, 1015) become 1000. */
export function sendableCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  return 1000;
}

/** Close without throwing: a reason over 123 bytes or a socket already closing is not an error here. */
function closeQuietly(socket: { close(code?: number, reason?: string): void }, code: number | undefined, reason: string) {
  try {
    socket.close(sendableCloseCode(code), reason);
  } catch {
    try { socket.close(sendableCloseCode(code)); } catch { /* already closed */ }
  }
}

function isConnectionRefused(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ConnectionRefused";
}

function unreachablePage(targetPort: number): Response {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>localhost:${targetPort} is not answering</title>
<body style="font:14px/1.5 system-ui,sans-serif;padding:24px;color:#444">
<h1 style="font-size:16px;margin:0 0 8px">Nothing answers on localhost:${targetPort}</h1>
<p style="margin:0">PPM could not reach a server on that port on the host. Start it, then reload this page.</p>`;
  return new Response(body, { status: 502, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

interface HopSocket {
  upstream: WebSocket;
  /** The browser's side, once it has opened; until then upstream messages queue. */
  client: ServerWebSocket<HopSocket> | null;
  queue: (string | ArrayBuffer)[];
  upstreamClosed: { code: number; reason: string } | null;
}

export interface ForwardHop {
  /** Loopback port the transport points at. */
  readonly port: number;
  readonly targetPort: number;
  /** Serve requests for the forward at `url`, once its transport has said where that is. */
  setPublicUrl(url: string): void;
  stop(): void;
}

/** Start a hop on `127.0.0.1:<random>` for the dev server on `targetPort`. */
export function startForwardHop(targetPort: number): ForwardHop {
  let upstreamHost: Loopback | null = null;
  /** The Host the forward's public URL sends, lower case and without a default port. */
  let publicHost: string | null = null;
  const sockets = new Set<ServerWebSocket<HopSocket>>();

  /** The loopback to dial; re-resolved when the last one refused, as a restarted dev server may bind the other family. */
  async function resolveUpstream(refresh: boolean): Promise<Loopback | null> {
    if (!upstreamHost || refresh) upstreamHost = await listeningLoopback(targetPort);
    return upstreamHost;
  }

  async function proxyHttp(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const headers = upstreamRequestHeaders(req.headers, targetPort, req.headers.get("host"));
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    for (const refresh of [false, true]) {
      const host = await resolveUpstream(refresh);
      if (!host) break;
      try {
        const res = await fetch(`http://${hostPart(host)}:${targetPort}${url.pathname}${url.search}`, {
          method: req.method, headers, body, redirect: "manual", signal: req.signal,
          // Pass the bytes through as they are: a body Bun had decoded would still carry the
          // upstream's Content-Encoding, and the browser would decode it a second time.
          decompress: false,
        });
        const nullBody = NULL_BODY_STATUS.has(res.status) || req.method === "HEAD";
        return new Response(nullBody ? null : res.body, {
          status: res.status, statusText: res.statusText, headers: downstreamResponseHeaders(res.headers, targetPort, framingOrigins()),
        });
      } catch (error) {
        // Only a refused connection is retried: anything later may have reached the dev
        // server already, and sending a POST twice is worse than a 502.
        if (!isConnectionRefused(error)) return unreachablePage(targetPort);
      }
    }
    return unreachablePage(targetPort);
  }

  async function openUpstreamSocket(req: Request): Promise<WebSocket | null> {
    const url = new URL(req.url);
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",").map((p) => p.trim()).filter(Boolean);
    const headers = Object.fromEntries(upstreamRequestHeaders(req.headers, targetPort, req.headers.get("host")));
    for (const refresh of [false, true]) {
      const host = await resolveUpstream(refresh);
      if (!host) return null;
      const ws = new UpstreamWebSocket(`ws://${hostPart(host)}:${targetPort}${url.pathname}${url.search}`, { headers, protocols });
      ws.binaryType = "arraybuffer";
      const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), WS_CONNECT_TIMEOUT_MS);
        const settle = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
        ws.addEventListener("open", () => settle(true), { once: true });
        ws.addEventListener("close", () => settle(false), { once: true });
      });
      if (opened) return ws;
      closeQuietly(ws, 1000, "");
    }
    return null;
  }

  const server = Bun.serve<HopSocket>({
    hostname: "127.0.0.1",
    port: 0,
    // Event streams and long polls (webpack's /__webpack_hmr) sit idle for longer than
    // Bun's default 10 s, which would cut them off mid-session.
    idleTimeout: 0,
    async fetch(req, srv) {
      if (req.headers.get("host")?.toLowerCase() !== publicHost) {
        return new Response("This forward does not answer for that host", { status: 421 });
      }
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return proxyHttp(req);
      // Open the dev server's socket first, so a refusal reaches the browser as a failed
      // handshake, as it would without the hop, rather than as an open socket that drops.
      const upstream = await openUpstreamSocket(req);
      if (!upstream) return new Response("The dev server refused the WebSocket", { status: 502 });
      const data: HopSocket = { upstream, client: null, queue: [], upstreamClosed: null };
      upstream.addEventListener("message", (e) => {
        const message = e.data as string | ArrayBuffer;
        if (data.client) data.client.send(message);
        else data.queue.push(message);
      });
      upstream.addEventListener("close", (e) => {
        if (data.client) closeQuietly(data.client, e.code, e.reason);
        else data.upstreamClosed = { code: e.code, reason: e.reason };
      });
      const headers = upstream.protocol ? { "Sec-WebSocket-Protocol": upstream.protocol } : undefined;
      if (srv.upgrade(req, { data, headers })) return undefined;
      closeQuietly(upstream, 1000, "");
      return new Response("WebSocket upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.data.client = ws;
        for (const message of ws.data.queue.splice(0)) ws.send(message);
        const closed = ws.data.upstreamClosed;
        if (closed) closeQuietly(ws, closed.code, closed.reason);
      },
      message(ws, message) {
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(message);
      },
      close(ws, code, reason) {
        sockets.delete(ws);
        const { upstream } = ws.data;
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          closeQuietly(upstream, code, reason);
        }
      },
    },
  });

  let stopped = false;
  return {
    port: server.port!,
    targetPort,
    setPublicUrl(url) {
      publicHost = new URL(url).host;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const ws of sockets) closeQuietly(ws.data.upstream, 1001, "");
      sockets.clear();
      server.stop(true);
    },
  };
}
