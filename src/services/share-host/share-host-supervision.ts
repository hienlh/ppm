/**
 * The share host as the supervisor runs it: the worker process, the connector that publishes it,
 * and what PPM's own connector has to carry for it in `shared` mode.
 *
 * Everything goes through `reconcileShareHost()`, which works out what should run (the plan from
 * the `share_host` row and PPM's tunnel) and changes only what differs from what runs now. It is
 * called at boot, on `reshare` (the settings changed), after `retunnel` (PPM's link changed) and
 * after the worker restarts. Calls are serialised.
 *
 * In `shared` mode PPM's tunnel is used by exactly one connector at a time: PPM's own while its
 * public link is on (it then routes the share hostname too, `routesForPpmConnector`), the share
 * host's while that link is off (routing the share hostname only). Two connectors on one tunnel
 * with different routes would have Cloudflare spread each hostname's requests over both.
 *
 * Once a review hostname has been set up, PPM's named connector routes by hostname and answers
 * any other with a 404, never with `--url`: that would serve PPM on every hostname pointing at
 * the tunnel, and the review hostname keeps pointing there while it is off, down or moved.
 *
 * What the server reads goes to status.json: `shareHostPid`/`shareHostPort` (the worker),
 * `shareHostMode`, `shareHostUrl` + `shareHostTunnelPid` (once a connector carrying the share
 * host is ready) and `shareHostWarning`.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { isMinimalMode } from "../runtime-mode.ts";
import { getConfigValue } from "../db.service.ts";
import { updateStatus } from "../supervisor-state.ts";
import { withoutNotifySocket } from "../sd-notify.ts";
import { STDIO_IS_LOG_ENV } from "../log-rotate.ts";
import { isCompiledBinary } from "../autostart-generator.ts";
import { createLogger } from "../logger.ts";
import type { ResolvedTunnelConfig, TunnelMode } from "../named-tunnel/named-tunnel-config.ts";
import {
  planShareHost, resolveShareHostConfig, SHARE_HOST_PORT_FILE, type ResolvedShareHostConfig, type ShareHostPlan,
} from "./share-host-config.ts";
import { sharedOwnArgs, shareNamedArgs, shareQuickArgs, type IngressRule } from "./share-host-args.ts";
import { ShareConnector, type ConnectorPlan } from "./share-host-connector.ts";

const log = createLogger("share-host");

const PORT_WAIT_MS = 5000;
export const SHARE_HOST_DOWN_WARNING = "Not connected to Cloudflare right now — reconnecting.";
export const SHARED_PPM_TEMPORARY_WARNING =
  "PPM's tunnel is on a temporary address for now, so the review address on it is down until your domain reconnects.";

export interface ShareHostSupervisorHooks {
  /** ppm.log, handed to the worker as stdout and stderr. */
  logFd: number;
  /** PPM's tunnel config, and whether its connector runs (the public link switch). */
  ppmTunnel: () => { config: ResolvedTunnelConfig | null; linkOn: boolean };
  /** Restart PPM's own connector, so it picks up or drops the share hostname. */
  restartPpmConnector: () => void;
  /** The supervisor's spawn gate (a port-probe socket must never be inherited). */
  gate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}

export interface ReconcileOptions {
  /**
   * PPM's connector is being (re)started by the caller right now and reads its routes as it
   * spawns, so reconciling must not restart it a second time.
   */
  ppmRestarting?: boolean;
}

/** What PPM's own connector routes, decided as it spawns. */
export interface PpmConnectorRoutes {
  /** PPM's hostname (and `share`) by ingress rules, a 404 for any other, instead of `--url`. */
  byHostname: boolean;
  /** The review hostname's route, while PPM's connector carries it (`shared-ppm`, worker up). */
  share: IngressRule | null;
}

/** `--url`: every hostname on the tunnel reaches PPM. */
export const PLAIN_PPM_ROUTES: PpmConnectorRoutes = { byHostname: false, share: null };

/**
 * What PPM's connector must route, with the worker on `port` (null while it has none). Only a
 * named connector has hostnames to route; a temporary address is a tunnel nothing else points at.
 */
export function ppmConnectorRoutes(
  share: ResolvedShareHostConfig, ppm: ResolvedTunnelConfig | null, port: number | null,
): PpmConnectorRoutes {
  if (ppm?.mode !== "named") return PLAIN_PPM_ROUTES;
  // Its link is on whenever it runs.
  const next = planShareHost(share, ppm, true);
  const rule = next.kind === "shared-ppm" && port !== null ? { hostname: next.hostname, port } : null;
  return { byHostname: share.domainSetUp || rule !== null, share: rule };
}

const sameRoutes = (a: PpmConnectorRoutes, b: PpmConnectorRoutes) =>
  a.byHostname === b.byHostname && a.share?.hostname === b.share?.hostname && a.share?.port === b.share?.port;

let hooks: ShareHostSupervisorHooks | null = null;
let config: ResolvedShareHostConfig = resolveShareHostConfig(null);
let plan: ShareHostPlan = { kind: "off" };
let worker: Subprocess | null = null;
let workerPort: number | null = null;
let workerStartedAt = 0;
let workerDeaths = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;
/** What PPM's connector was last started with; null when this supervisor has not started one. */
let ppmRoutes: PpmConnectorRoutes | null = null;
const connector = new ShareConnector({ gate: (fn) => (hooks ? hooks.gate(fn) : Promise.resolve(fn())) });
let chain: Promise<void> = Promise.resolve();

/** Fresh read of the `share_host` row: the server writes it, and this process caches nothing. */
export function readShareHostConfigFresh(): ResolvedShareHostConfig {
  // Keep saved review-host settings intact, but never spawn its worker/connector
  // in chat-only mode, including a reshare/retunnel request from an older client.
  if (isMinimalMode()) return resolveShareHostConfig(null);
  return resolveShareHostConfig(getConfigValue("share_host"));
}

function workerCmd(port: number): string[] {
  const args = ["__share_host__", String(port)];
  return isCompiledBinary()
    ? [process.execPath, ...args]
    : [process.execPath, "run", resolve(import.meta.dir, "share-host-worker.ts"), ...args];
}

/** Whether `pid` is a share host worker, by its command line (never kill a recycled pid). */
function isShareHostWorker(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("__share_host__");
    }
    if (process.platform === "darwin") {
      const out = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)]);
      return new TextDecoder().decode(out.stdout).includes("__share_host__");
    }
  } catch {}
  return false;
}

/** A worker left by the previous supervisor (an upgrade, a crash) would hold on to nothing useful. */
function killLeftoverWorker(pid: unknown): void {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (!isShareHostWorker(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
    log.info(`Stopped the share host worker left by the previous supervisor (PID ${pid})`);
  } catch {}
}

function publish(patch: Record<string, unknown>): void {
  updateStatus(patch);
}

async function waitForPort(proc: Subprocess): Promise<number | null> {
  const deadline = Date.now() + PORT_WAIT_MS;
  while (Date.now() < deadline && proc.exitCode === null) {
    try {
      if (existsSync(SHARE_HOST_PORT_FILE())) {
        const port = parseInt(readFileSync(SHARE_HOST_PORT_FILE(), "utf8").trim(), 10);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
      }
    } catch {}
    await Bun.sleep(50);
  }
  return null;
}

/** Start the worker again after a backoff that grows while it keeps failing young. */
function retryWorkerLater(why: string): void {
  workerDeaths = Date.now() - workerStartedAt > 5 * 60_000 ? 1 : workerDeaths + 1;
  const delay = Math.min(30_000, 500 * 2 ** Math.min(workerDeaths - 1, 6));
  log.warn(`${why} — starting it again in ${delay} ms`);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void reconcileShareHost();
  }, delay);
}

function onWorkerExit(proc: Subprocess, code: number | null): void {
  if (worker !== proc) return; // stopped or replaced on purpose
  worker = null;
  if (stopping || plan.kind === "off" || plan.kind === "unavailable") return;
  publish({ shareHostPid: null });
  retryWorkerLater(`Share host worker exited (code ${code})`);
}

/** The worker's port, starting the worker when it does not run. Keeps its last port when it can. */
async function ensureWorker(): Promise<number | null> {
  if (worker && worker.exitCode === null && workerPort !== null) return workerPort;
  if (!hooks) return null;
  try { unlinkSync(SHARE_HOST_PORT_FILE()); } catch {}
  const logFd = hooks.logFd;
  workerStartedAt = Date.now();
  let proc: Subprocess;
  try {
    proc = await hooks.gate(() => Bun.spawn({
      cmd: workerCmd(workerPort ?? 0),
      stdio: ["ignore", logFd, logFd],
      // Told that its stderr is ppm.log, which it cannot work out on Windows (see logger.ts).
      env: { ...withoutNotifySocket(process.env), [STDIO_IS_LOG_ENV]: "1" },
      windowsHide: true,
    }));
  } catch (error) {
    // Bun.spawn throws instead of starting a process that fails, so no exit will retry it.
    retryWorkerLater(`Share host worker could not be started: ${error}`);
    return null;
  }
  worker = proc;
  void proc.exited.then((code) => onWorkerExit(proc, code));
  publish({ shareHostPid: proc.pid });
  const port = await waitForPort(proc);
  if (port === null) {
    log.error(`Share host worker (PID ${proc.pid}) did not report a port within ${PORT_WAIT_MS} ms`);
    try { proc.kill("SIGTERM"); } catch {}
    return null;
  }
  if (workerPort !== null && port !== workerPort) log.warn(`Share host worker moved from port ${workerPort} to ${port}`);
  workerPort = port;
  publish({ shareHostPort: port });
  log.info(`Share host worker started on 127.0.0.1:${port} (PID ${proc.pid})`);
  return port;
}

function stopWorker(): void {
  const proc = worker;
  worker = null;
  workerPort = null;
  if (proc) {
    try { proc.kill("SIGTERM"); } catch {}
  }
}

/** Run `next` on the share host's own connector unless exactly that already runs. */
function runOwnConnector(next: ConnectorPlan): void {
  const now = connector.plan;
  if (now && now.label === next.label && JSON.stringify(now.args) === JSON.stringify(next.args)) return;
  publish({ shareHostUrl: next.url, shareHostTunnelPid: null, shareHostWarning: null });
  connector.start(next, {
    onReady: ({ pid, url }) => publish({ shareHostUrl: url, shareHostTunnelPid: pid, shareHostWarning: null }),
    // A quick address is gone with its process; a named one is pinned, and the dead pid says it is down.
    onDown: () => publish({
      ...(next.url ? {} : { shareHostUrl: null }), shareHostTunnelPid: null, shareHostWarning: SHARE_HOST_DOWN_WARNING,
    }),
  });
}

/** Restart PPM's connector when what it routes is not what it must route now. */
function syncPpmConnector(ppm: { config: ResolvedTunnelConfig | null; linkOn: boolean }, opts: ReconcileOptions): void {
  if (!ppm.linkOn || opts.ppmRestarting) return;
  if (sameRoutes(ppmRoutes ?? PLAIN_PPM_ROUTES, ppmConnectorRoutes(config, ppm.config, workerPort))) return;
  hooks?.restartPpmConnector();
}

async function reconcileNow(opts: ReconcileOptions): Promise<void> {
  if (!hooks || stopping) return;
  const ppm = hooks.ppmTunnel();
  const next = planShareHost(config, ppm.config, ppm.linkOn);
  plan = next;

  if (next.kind === "off" || next.kind === "unavailable") {
    connector.stop();
    stopWorker();
    publish({
      shareHostMode: next.kind === "off" ? null : config.mode, shareHostPid: null, shareHostPort: null,
      shareHostUrl: null, shareHostTunnelPid: null,
      shareHostWarning: next.kind === "unavailable" ? next.reason : null,
    });
    // PPM's connector may still route the share hostname to a worker that is gone.
    syncPpmConnector(ppm, opts);
    return;
  }

  publish({ shareHostMode: config.mode });
  const port = await ensureWorker();
  if (port === null) {
    // Tried again after a backoff; say why links do not open meanwhile.
    publish({ shareHostUrl: null, shareHostTunnelPid: null, shareHostWarning: "The review address could not start; retrying." });
    syncPpmConnector(ppm, opts);
    return;
  }

  switch (next.kind) {
    case "quick":
      runOwnConnector({ label: "quick", args: shareQuickArgs(port), url: null });
      break;
    case "named":
      runOwnConnector({ label: `named ${next.hostname}`, args: shareNamedArgs(next.token, port), url: `https://${next.hostname}` });
      break;
    case "shared-own":
      runOwnConnector({
        label: `shared ${next.hostname}`, args: sharedOwnArgs(next.token, { hostname: next.hostname, port }),
        url: `https://${next.hostname}`,
      });
      break;
    case "shared-ppm":
      connector.stop();
      if (!sameRoutes(ppmRoutes ?? PLAIN_PPM_ROUTES, ppmConnectorRoutes(config, ppm.config, port))) {
        // Down until PPM's connector is up again with the route (`notePpmConnectorReady`).
        publish({ shareHostUrl: null, shareHostTunnelPid: null, shareHostWarning: null });
      }
      break;
  }
  // PPM's connector picks the share hostname's route up, or drops it now that the share host runs its own.
  syncPpmConnector(ppm, opts);
}

/** Bring what runs in line with the settings and PPM's tunnel. Serialised; never rejects. */
export function reconcileShareHost(opts: ReconcileOptions = {}): Promise<void> {
  chain = chain.then(() => reconcileNow(opts)).catch((error) => log.error(`Share host reconcile failed: ${error}`));
  return chain;
}

/** Boot: stop a worker left by the previous supervisor, read the settings, start what they ask for. */
export async function initShareHost(h: ShareHostSupervisorHooks, previousWorkerPid: unknown, opts: ReconcileOptions = {}): Promise<void> {
  hooks = h;
  stopping = false;
  killLeftoverWorker(previousWorkerPid);
  try {
    config = readShareHostConfigFresh();
  } catch (error) {
    log.error(`Share host settings unreadable — leaving it off: ${error}`);
    config = resolveShareHostConfig(null);
  }
  await reconcileShareHost(opts);
}

/** `reshare`: the settings changed. */
export function reloadShareHost(): Promise<void> {
  try {
    config = readShareHostConfigFresh();
  } catch (error) {
    log.error(`Share host settings unreadable — keeping the last ones: ${error}`);
  }
  return reconcileShareHost();
}

/** Supervisor shutdown: the worker and its connector go with it. */
export function stopShareHost(): void {
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  connector.stop();
  stopWorker();
}

/**
 * Whether PPM's connector routes by hostname under these settings. The supervisor asks before
 * adopting a connector left by the previous one: such a connector is replaced instead, because
 * another process chose its routes (an older build's `--url`, or the previous worker's port).
 */
export function ppmConnectorRoutesByHostname(ppm: ResolvedTunnelConfig | null): boolean {
  let share: ResolvedShareHostConfig;
  try {
    share = readShareHostConfigFresh();
  } catch {
    return false;
  }
  return ppmConnectorRoutes(share, ppm, null).byHostname;
}

/**
 * What PPM's connector must route as it spawns. Called only while PPM's link is on (that is the
 * only time its connector runs), and remembered, so a later reconcile can tell whether the
 * running connector still matches.
 */
export function routesForPpmConnector(ppm: ResolvedTunnelConfig | null): PpmConnectorRoutes {
  ppmRoutes = ppmConnectorRoutes(config, ppm, workerPort);
  return ppmRoutes;
}

/** PPM's connector is up: if it carries the share hostname, the share host is reachable too. */
export function notePpmConnectorReady(pid: number, mode: TunnelMode): void {
  if (plan.kind !== "shared-ppm") return;
  const share = ppmRoutes?.share;
  if (mode === "named" && share) {
    publish({ shareHostUrl: `https://${share.hostname}`, shareHostTunnelPid: pid, shareHostWarning: null });
  } else {
    publish({ shareHostUrl: null, shareHostTunnelPid: null, shareHostWarning: SHARED_PPM_TEMPORARY_WARNING });
  }
}
