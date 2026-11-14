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
import { createLogger, installFileLogSink } from "./logger.ts";
import { registerMemoryGauge, startMemoryDiagnostics } from "./memory-diagnostics.ts";
import { readNativeMemory } from "./memory-diagnostics-native.ts";
import {
  EDGE_RECYCLE_CHECK_MS,
  EDGE_RECYCLE_CONFIRM_READINGS,
  EDGE_RECYCLE_EXIT_CODE,
  EDGE_RECYCLE_QUIET_CONNECTIONS,
  edgeOverLimit,
  edgeRecycleLimitMB,
  shouldRecycleEdge,
} from "./edge-recycle-policy.ts";

const log = createLogger("edge");

/**
 * How many times in a row the edge before this one died, as counted by the supervisor. From
 * the second repeat on, the supervisor has already reported the dark port, so this process's
 * own failure to bind is detail rather than news.
 */
export const EDGE_PRIOR_DEATHS_ENV = "PPM_EDGE_PRIOR_DEATHS";

/** Delay between attempts while waiting for the server to come back. */
const CONNECT_RETRY_MS = 250;
/**
 * How long a client connection waits for a reachable server before giving up.
 * During an upgrade the server is briefly absent; refusing instantly would
 * surface as a broken page rather than a slow one.
 */
const CONNECT_WINDOW_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Client connections open right now, and ever: the memory watchdog's view of the edge's load. */
let openConnections = 0;
let totalConnections = 0;
registerMemoryGauge("edge.openConnections", () => openConnections);
registerMemoryGauge("edge.totalConnections", () => totalConnections);

/** At most one warning a minute about connections dropped for want of a server. */
const DROP_WARN_INTERVAL_MS = 60_000;
let droppedSinceWarning = 0;
let droppedSinceServerSeen = 0;
let lastDropWarningAt = 0;

/**
 * A client was dropped because no server answered in time: the public URL hangs and then
 * fails, and nothing else in the log shows it. Warned about at most once a minute, with the
 * count of the ones in between.
 */
function noteDroppedConnection(connectWindowMs: number): void {
  droppedSinceWarning++;
  droppedSinceServerSeen++;
  const now = Date.now();
  if (now - lastDropWarningAt < DROP_WARN_INTERVAL_MS) return;
  const since = lastDropWarningAt ? "since the last warning" : "so far";
  log.warn(`No server on .server-port=${resolveTargetPort() ?? "none"} within ${connectWindowMs}ms — dropped ${droppedSinceWarning} connection(s) ${since}`);
  lastDropWarningAt = now;
  droppedSinceWarning = 0;
}

/** The server answered again after connections were dropped: the outage is over. */
function noteServerReachable(port: number): void {
  if (droppedSinceServerSeen === 0) return;
  log.info(`Server reachable again on port ${port} — ${droppedSinceServerSeen} connection(s) were dropped while it was not`);
  droppedSinceServerSeen = 0;
  droppedSinceWarning = 0;
  lastDropWarningAt = 0;
}

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
        noteServerReachable(port);
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
    noteDroppedConnection(connectWindowMs);
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

/** What the edge saw when it decided to recycle. */
export interface EdgeRecycleInfo {
  privateMB: number;
  limitMB: number;
  openConnections: number;
}

export interface EdgeRecycleOptions {
  limitMB: number;
  /** This process's private bytes in MB, or undefined when unreadable. */
  readPrivateMB: () => Promise<number | undefined>;
  /** Called once, after the listener and every client socket are closed. */
  onRecycle: (info: EdgeRecycleInfo) => void;
  checkIntervalMs?: number;
  quietConnections?: number;
  /** Over-limit readings in a row before recycling. */
  confirmReadings?: number;
}

export interface EdgeForwarderOptions {
  publicPort: number;
  host?: string;
  /** How long a client waits for a reachable server. Defaults to 5s. */
  connectWindowMs?: number;
  /** Release the port once memory passes a limit while few clients are connected. Off when absent. */
  recycle?: EdgeRecycleOptions;
}

/**
 * Check memory on a timer and, once over the limit at a quiet moment, close the listener
 * and the few open clients and hand over to `onRecycle`. Closing the listener first is what
 * lets the successor bind the same port the moment it starts; the clients that were cut
 * (a WebSocket, a cloudflared origin connection) reconnect to that successor.
 */
function watchForRecycle(server: net.Server, clients: Set<net.Socket>, opts: EdgeRecycleOptions): void {
  let recycling = false;
  let overStreak = 0;
  const confirm = opts.confirmReadings ?? EDGE_RECYCLE_CONFIRM_READINGS;
  const timer = setInterval(async () => {
    if (recycling) return;
    const privateMB = await opts.readPrivateMB();
    if (recycling) return;
    overStreak = edgeOverLimit(privateMB, opts.limitMB) ? overStreak + 1 : 0;
    if (overStreak < confirm || !shouldRecycleEdge(privateMB, clients.size, opts.limitMB, opts.quietConnections)) return;
    recycling = true;
    clearInterval(timer);
    const info: EdgeRecycleInfo = { privateMB: privateMB!, limitMB: opts.limitMB, openConnections: clients.size };
    log.warn(`Recycling: private ${info.privateMB}MB >= ${info.limitMB}MB with ${info.openConnections} open connection(s) — releasing the port for a fresh edge`);
    server.close();
    for (const c of clients) c.destroy();
    opts.onRecycle(info);
  }, opts.checkIntervalMs ?? EDGE_RECYCLE_CHECK_MS);
  // The check must never be what keeps the process alive.
  timer.unref?.();
  server.once("close", () => clearInterval(timer));
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
  const clients = new Set<net.Socket>();
  return new Promise((resolvePromise, reject) => {
    // allowHalfOpen keeps the other direction alive when one side sends FIN —
    // long-lived chat WS and SSE streams depend on it.
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      openConnections++;
      totalConnections++;
      clients.add(client);
      client.once("close", () => { openConnections--; clients.delete(client); });
      void handleConnection(client, connectWindowMs);
    });
    server.once("error", reject);
    server.listen(opts.publicPort, host, () => {
      server.removeListener("error", reject);
      if (opts.recycle) watchForRecycle(server, clients, opts.recycle);
      resolvePromise(server);
    });
  });
}

// ─── Process entry ─────────────────────────────────────────────────────
// Mirrors the `__serve__` guard in src/server/index.ts: the supervisor
// re-invokes the binary as `<bin> __edge__ <publicPort> <host>`.
if (process.argv.includes("__edge__")) {
  // Lines go to ppm.log with a timestamp and level like every other process's. The
  // supervisor hands the log over as stderr, so the stderr echo is skipped (see logger.ts).
  installFileLogSink({ echo: "stderr" });
  // Reads memory through the OS only: it spawns nothing, so the invariant above holds.
  startMemoryDiagnostics({ role: "edge" });
  const idx = process.argv.indexOf("__edge__");
  const publicPort = parseInt(process.argv[idx + 1] ?? "", 10);
  const host = process.argv[idx + 2] ?? "0.0.0.0";

  if (!Number.isInteger(publicPort) || publicPort <= 0 || publicPort > 65535) {
    log.fatal(`Invalid public port: ${process.argv[idx + 1]} — exiting`);
    process.exit(2);
  }

  // Windows only (see edge-recycle-policy.ts): the supervisor sees the exit code and starts
  // the successor at once, which binds the port this process has just released.
  const limitMB = edgeRecycleLimitMB();
  const recycle: EdgeRecycleOptions | undefined = limitMB === null ? undefined : {
    limitMB,
    quietConnections: EDGE_RECYCLE_QUIET_CONNECTIONS,
    readPrivateMB: async () => (await readNativeMemory()).privateMB,
    onRecycle: () => process.exit(EDGE_RECYCLE_EXIT_CODE),
  };

  try {
    await startEdgeForwarder({ publicPort, host, recycle });
    log.info(`Listening on ${host}:${publicPort}${limitMB === null ? "" : ` (recycles above ${limitMB}MB private)`}`);
  } catch (err) {
    const repeat = Number(process.env[EDGE_PRIOR_DEATHS_ENV]) >= 2;
    log[repeat ? "debug" : "fatal"](`Failed to bind ${host}:${publicPort}: ${err} — exiting`);
    process.exit(1);
  }
}
