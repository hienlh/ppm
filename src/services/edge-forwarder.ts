/**
 * Edge forwarder — owns the public port and pipes raw TCP to the server's
 * current loopback port.
 *
 * ─── CRITICAL INVARIANT: THIS PROCESS MUST NEVER SPAWN A CHILD ───
 *
 * On Windows a child spawned with fd stdio inherits every inheritable handle,
 * including a listening socket. When such a descendant is orphaned it keeps the
 * socket open, so the port stays in LISTEN under a dead PID and can never be
 * rebound — a "zombie port". The server hits this constantly because it spawns
 * chat/tool/MCP subprocesses; those inherit its listener and wedge its port.
 *
 * The edge exists precisely because it spawns nothing, so its socket cannot be
 * inherited and its port cannot zombie. cloudflared can therefore stay pinned
 * to it forever and the public URL stops rotating. Adding any child-process
 * call to this file reintroduces the exact bug the edge was built to remove.
 *
 * Raw TCP, never HTTP: WebSocket upgrades and SSE streams pass through
 * untouched, and forwarded requests keep the headers cloudflared set.
 */
import net from "node:net";
import { resolveTargetPort, _resetTargetCache } from "./edge-target-resolver.ts";

/** Delay between attempts while waiting for the server to come back. */
const CONNECT_RETRY_MS = 250;
/**
 * How long a client connection waits for a reachable server before giving up.
 * During an upgrade the server is briefly absent; refusing instantly would
 * surface as a broken page rather than a slow one.
 */
const CONNECT_WINDOW_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve once the socket is connected; reject on the first connect error. */
function connectUpstream(port: number): Promise<net.Socket> {
  return new Promise((resolvePromise, reject) => {
    const upstream = net.connect({
      port,
      host: "127.0.0.1", // never taken from status.json — loopback only
      allowHalfOpen: true,
    });
    const onError = (err: Error) => {
      upstream.destroy();
      reject(err);
    };
    upstream.once("error", onError);
    upstream.once("connect", () => {
      upstream.removeListener("error", onError);
      resolvePromise(upstream);
    });
  });
}

/**
 * Largest amount of client data held while waiting for the server. Bounds the
 * memory a slow upload can pin during an upgrade window.
 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/**
 * Pipe one client connection to the server.
 *
 * Resolving the upstream is async, so the first bytes usually arrive before
 * there is anywhere to send them. They must be captured by a `data` listener
 * attached synchronously on this very tick and replayed once the upstream
 * exists.
 *
 * `socket.pause()` is NOT a substitute — verified against Bun 1.3.13: bytes
 * that arrive while paused are lost, and a later `pipe()`/`resume()` does not
 * bring them back. A socket with no `data` listener drops them outright too.
 * Both variants silently swallowed the first request in testing.
 */
async function handleConnection(
  client: net.Socket,
  connectWindowMs: number,
): Promise<void> {
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let clientEnded = false;
  const onEarlyData = (chunk: Buffer) => {
    pendingBytes += chunk.length;
    if (pendingBytes > MAX_PENDING_BYTES) {
      client.destroy();
      return;
    }
    pending.push(chunk);
  };
  client.on("data", onEarlyData);
  client.once("end", () => { clientEnded = true; });

  let upstream: net.Socket | null = null;
  let clientGone = false;

  // A socket error with no listener is an unhandled 'error' event, which would
  // take the whole edge process — and the public port — down with it.
  const teardown = () => {
    upstream?.destroy();
    client.destroy();
  };
  client.on("error", teardown);
  client.once("close", () => { clientGone = true; });

  const deadline = Date.now() + connectWindowMs;
  while (!clientGone && Date.now() < deadline) {
    const port = resolveTargetPort();
    if (port !== null) {
      try {
        upstream = await connectUpstream(port);
        break;
      } catch {
        // Server not up yet (or moved mid-restart) — re-resolve and retry.
        _resetTargetCache();
      }
    }
    await sleep(CONNECT_RETRY_MS);
  }

  if (clientGone) return;
  if (!upstream) {
    client.destroy();
    return;
  }

  upstream.on("error", teardown);

  // Replay what arrived during the connect, then hand both directions to the
  // stream machinery. Removing the listener and piping happen in the same tick,
  // so no chunk can slip through the gap.
  client.off("data", onEarlyData);
  for (const chunk of pending) upstream.write(chunk);
  pending.length = 0;

  client.pipe(upstream);
  upstream.pipe(client);

  // The client may have half-closed while we were still connecting.
  if (clientEnded) upstream.end();
}

export interface EdgeForwarderOptions {
  publicPort: number;
  host?: string;
  /** How long a client waits for a reachable server. Defaults to 5s. */
  connectWindowMs?: number;
}

/**
 * Bind the public port and start forwarding. Resolves once listening so the
 * caller can fail fast when the port is unavailable.
 */
export function startEdgeForwarder(
  opts: EdgeForwarderOptions,
): Promise<net.Server> {
  const host = opts.host ?? "0.0.0.0";
  const connectWindowMs = opts.connectWindowMs ?? CONNECT_WINDOW_MS;
  return new Promise((resolvePromise, reject) => {
    // allowHalfOpen keeps the other direction alive when one side sends FIN —
    // long-lived chat WS and SSE streams depend on it.
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      void handleConnection(client, connectWindowMs);
    });
    server.once("error", reject);
    server.listen(opts.publicPort, host, () => {
      server.removeListener("error", reject);
      resolvePromise(server);
    });
  });
}

// ─── Process entry ─────────────────────────────────────────────────────
// Mirrors the `__serve__` guard in src/server/index.ts: the supervisor
// re-invokes the binary as `<bin> __edge__ <publicPort> <host>`.
if (process.argv.includes("__edge__")) {
  const idx = process.argv.indexOf("__edge__");
  const publicPort = parseInt(process.argv[idx + 1] ?? "", 10);
  const host = process.argv[idx + 2] ?? "0.0.0.0";

  if (!Number.isInteger(publicPort) || publicPort <= 0 || publicPort > 65535) {
    process.stderr.write(`[edge] Invalid public port: ${process.argv[idx + 1]}\n`);
    process.exit(2);
  }

  try {
    await startEdgeForwarder({ publicPort, host });
    process.stderr.write(`[edge] Listening on ${host}:${publicPort}\n`);
  } catch (err) {
    process.stderr.write(`[edge] Failed to bind ${host}:${publicPort}: ${err}\n`);
    process.exit(1);
  }
}
