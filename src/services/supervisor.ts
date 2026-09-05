/**
 * Supervisor process — long-lived parent that manages server child + tunnel child.
 * Respawns children on crash with exponential backoff.
 * Health-checks server (/api/health) and tunnel URL (public probe).
 * Entry: __supervise__ <port> <host> [profile] [--share]
 */
import type { Subprocess } from "bun";
import { resolve } from "node:path";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, appendFileSync,
  unlinkSync, statSync,
} from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";
import { isCompiledBinary } from "./autostart-generator.ts";
import { cleanupStaleBinaryUpgradeArtifacts } from "./binary-upgrade-swap.ts";
import {
  type SupervisorState,
  getState, setState, waitForResume, triggerResume,
  readAndDeleteCmd, readStatus, updateStatus, writeStatus,
  STATUS_FILE, PID_FILE,
} from "./supervisor-state.ts";
import type { ResolvedTunnelConfig, TunnelMode } from "./named-tunnel/named-tunnel-config.ts";
import { readTunnelConfigFresh, chooseTunnelSpawn } from "./named-tunnel/named-tunnel-runtime.ts";
import { waitForLogLine } from "./named-tunnel/named-tunnel-readiness.ts";
import { decideNamedProbeAction } from "./named-tunnel/named-tunnel-probe-state.ts";
import { isCloudflaredPid } from "./tunnel-registry.service.ts";
import { getQuickTunnelArgs } from "./cloudflared.service.ts";
import { startStoppedPage, stopStoppedPage } from "./supervisor-stopped-page.ts";
import { sdNotify } from "./sd-notify.ts";
import {
  killProcessTree, snapshotServerDescendants, reapTrackedDescendants,
  findPortListenerPid, isPpmProcess, collectProcessTree, terminateTree,
} from "./windows-process-tree.ts";
import { reapZombiePortOrphans } from "./windows-zombie-port-reaper.ts";
import {
  SERVER_PORT_FILE, resolveTargetPort, _resetTargetCache,
} from "./edge-target-resolver.ts";
import { PLIST_LABEL } from "./autostart-generator.ts";

// ─── Constants ─────────────────────────────────────────────────────────
const MAX_RESTARTS = 10;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_WINDOW_MS = 300_000;       // 5min stable → reset restart counter
const SERVER_HEALTH_INTERVAL_MS = 30_000;
const SERVER_HEALTH_FAIL_THRESHOLD = 3;
const PORT_PROBE_TIMEOUT_MS = 2000;         // a bind probe must never stall the server spawn
const SERVER_REVIVE_AFTER_MS = 90_000;      // > BACKOFF_MAX_MS, so crash backoff is never mistaken for a stall
const TUNNEL_PROBE_INTERVAL_MS = 30_000;    // 30s — adopted tunnels have no `exited` promise
const TUNNEL_ZOMBIE_THRESHOLD = 10;         // ~5min @ 30s probe — only regenerate a truly-zombied URL (process alive, edge dropped). cloudflared self-heals transient QUIC drops, so don't kill it early.
const TUNNEL_URL_REGEX = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;
const NAMED_TUNNEL_READY_REGEX = /Registered tunnel connection/;
const UPGRADE_CHECK_INTERVAL_MS = 900_000;  // 15min
const UPGRADE_SKIP_INITIAL_MS = 300_000;    // 5min delay before first check
const SELF_REPLACE_TIMEOUT_MS = 30_000;     // 30s to wait for new supervisor
const EDGE_PROBE_INTERVAL_MS = 10_000;      // the public port is dark while the edge is down — check often
const SERVER_PORT_MIRROR_TIMEOUT_MS = 30_000; // how long to wait for the server to publish its port

const logFile = () => resolve(getPpmDir(), "ppm.log");
const restartingFlag = () => resolve(getPpmDir(), ".restarting");
const serverShutdownFile = () => resolve(getPpmDir(), ".server-shutdown");

// ─── State ─────────────────────────────────────────────────────────────
let serverChild: Subprocess | null = null;
let tunnelChild: Subprocess | null = null;
let tunnelUrl: string | null = null;
let tunnelPort: number | null = null; // origin port the live tunnel targets
let adoptedTunnelPid: number | null = null; // PID of tunnel kept alive across upgrade
// PID of the edge forwarder. Like the tunnel it is spawned detached so it
// survives self-replace, so a new supervisor adopts it rather than respawning.
let edgePid: number | null = null;
let edgeProbeTimer: ReturnType<typeof setInterval> | null = null;
// The loopback port our own server child published. Cleared on every respawn so
// a stale value never fights the incoming generation. Once set, it makes the
// supervisor the authority on what `.server-port` should contain.
let serverPublishedPort: number | null = null;
let shuttingDown = false;
// Monotonic token for the authoritative tunnel loop. Every EXTERNAL (re)start
// bumps it; a loop whose captured generation is stale must exit instead of
// respawning, so restarts never leave two concurrent spawnTunnel loops racing
// (the old leak that spawned dozens of orphaned cloudflared processes).
let tunnelGeneration = 0;
// Throttle tunnel regeneration. A quick-tunnel URL rotation spawns a NEW
// cloudflared → trycloudflare rate-limits quick tunnels per source IP, so a
// sleep/wake storm that regenerates hundreds of times gets the whole IP
// throttled and NO new tunnel can register ("control stream encountered a
// failure while serving"). Never rotate more than once per this window.
let lastTunnelRegenAt = 0;
const TUNNEL_REGEN_MIN_INTERVAL_MS = 300_000; // 5min

// Named-tunnel state. `namedTunnelMode` is a synchronous cache refreshed at
// exactly three points (startup, start of spawnTunnel, retunnel dispatch) —
// every OTHER reader (restartTunnel, adoptTunnel, the probe) must read this
// cache, never `configService` (a separate process, stale here) nor a fresh
// async DB read (would reorder the startup adopt/probe-before-spawn race).
let namedTunnelMode: ResolvedTunnelConfig | null = null;
// The mode of the tunnel actually spawned (as opposed to `namedTunnelMode`,
// which is merely the persisted intent) — a token failure leaves config=named
// but live=quick, and every status write / throttle / restart decision must
// key off what's actually running.
let lastSpawnMode: TunnelMode = "quick";
// Set once the named probe has already tried a restart-and-hope; a second
// consecutive failure then warns and stops instead of looping kills forever.
let namedProbeRestartAttempted = false;

// Module-level refs for softStop (needs access to respawn args)
let _serverArgs: string[] = [];
let _logFd: number = -1;
let _opts: { port: number; host: string; share: boolean } = { port: 8080, host: "0.0.0.0", share: false };

let serverRestarts = 0;
let lastServerCrash = 0;
let tunnelRestarts = 0;
let lastTunnelCrash = 0;

let healthFailCount = 0;
let noServerChildCycles = 0; // consecutive health cycles with no server child
let tunnelFailCount = 0;
let serverRestartRequested = false; // SIGUSR2 flag — skip backoff on next crash

// Timers for cleanup
let healthTimer: ReturnType<typeof setInterval> | null = null;
let tunnelProbeTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let upgradeCheckTimer: ReturnType<typeof setInterval> | null = null;
let upgradeDelayTimer: ReturnType<typeof setTimeout> | null = null;
let cloudMonitorTimer: ReturnType<typeof setInterval> | null = null;
let descendantSnapshotTimer: ReturnType<typeof setInterval> | null = null; // win32 only
let cloudConnected = false; // tracks whether we've initiated a cloud WS connection

// Saved at startup for self-replace
let originalArgv: string[] = [];

// ─── Logging ───────────────────────────────────────────────────────────
function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [supervisor] ${msg}\n`;
  try { appendFileSync(logFile(), line); } catch {}
  // Always write supervisor logs to stderr so journalctl captures them
  try { process.stderr.write(line); } catch {}
}

// ─── Backoff calc ──────────────────────────────────────────────────────
function backoffDelay(restartCount: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (restartCount - 1), BACKOFF_MAX_MS);
}

// ─── Probe/spawn gate ──────────────────────────────────────────────────
// On Windows, spawning a child with fd stdio turns on handle inheritance for
// the whole process, so EVERY inheritable handle — including a port-probe
// listener that happens to be open at that instant — is duplicated into the
// child. The child (cloudflared, server) never closes the copy, the kernel
// keeps the port in LISTEN, and the server child can never bind: startup
// crash-loops with "port still in use" while netstat blames the supervisor.
// Serialize all bind probes and all child spawns through this gate so a probe
// socket is never open across a CreateProcess. Never nest gated calls.
let probeSpawnGate: Promise<unknown> = Promise.resolve();
function withProbeSpawnGate<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = probeSpawnGate.then(fn);
  probeSpawnGate = run.catch(() => {});
  return run;
}

// ─── Port recovery ─────────────────────────────────────────────────────
// The probe socket really listens, so clients retrying against the port (browser
// tabs, extension/chat WebSockets after a server restart) can connect to it. An
// open connection makes close(cb) wait forever, which used to hang spawnServer
// before it ever spawned — supervisor alive, tunnel alive, nothing serving.
// Hence: drop incoming connections, and never let the probe outlive the timeout.
function isPortBindable(port: number, host: string): Promise<boolean> {
  // Gated: the probe listener must never be open while a child is spawned,
  // or the child inherits the socket handle and wedges the port (see gate).
  return withProbeSpawnGate(() => new Promise<boolean>((resolve) => {
    const net = require("node:net") as typeof import("node:net");
    let settled = false;
    const finish = (bindable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(bindable);
    };
    const timer = setTimeout(() => {
      log("WARN", `Port probe for ${port} timed out — treating as unbindable`);
      try { tester.close(); } catch {}
      finish(false);
    }, PORT_PROBE_TIMEOUT_MS);
    const tester = net.createServer();
    tester.on("connection", (socket) => socket.destroy());
    tester.once("error", () => finish(false));
    tester.once("listening", () => tester.close(() => finish(true)));
    tester.listen(port, host);
  }));
}

/**
 * Resolve a port the next server child can actually bind. Returns `preferred`
 * unchanged on the happy path.
 *
 * Windows: after a hibernate/resume the previous server's orphaned child can
 * keep the listening socket open via an inherited handle the OS will not
 * release (a "zombie port"). Binding the same port then fails forever, so we
 * reap orphans and, as a last resort, fall back to a nearby port.
 *
 * POSIX: no such failure mode — a busy port means a live listener. We reclaim
 * our own orphans but NEVER fall back, because a fallback turns a duplicate
 * launch into a second full instance instead of a visible error.
 */
async function ensureBindablePort(preferred: number, host: string): Promise<number> {
  if (await isPortBindable(preferred, host)) return preferred;

  if (process.platform === "win32") {
    await reapTrackedDescendants((m) => log("INFO", m)).catch(() => {});
    const holderPid = findPortListenerPid(preferred);
    if (holderPid > 0) {
      let alive = false;
      try { process.kill(holderPid, 0); alive = true; } catch {}
      if (holderPid === process.pid) {
        // The LISTEN entry is our own leaked probe socket, kept open by a
        // child that inherited the handle at spawn time. killProcessTree here
        // would kill THIS supervisor (and everything under it) — the exact
        // "starts then dies, status.json says running" failure. Bounce the
        // tunnel instead: cloudflared is the detached child holding the
        // inherited handle, and replacing it releases the port.
        log("WARN", `Port ${preferred} LISTEN owned by this supervisor — leaked probe handle inherited by a child; bouncing tunnel to release it`);
        restartTunnel(preferred);
        await Bun.sleep(1500);
      } else if (alive && isPpmProcess(holderPid)) {
        log("WARN", `Port ${preferred} held by stale PPM process (PID ${holderPid}) — reclaiming`);
        killProcessTree(holderPid);
        await Bun.sleep(800);
      } else if (!alive) {
        // Zombie socket: LISTEN entry owned by a dead PID, handle kept open by
        // orphaned descendants that inherited it (daemonized chat-tool debris
        // the tracked-descendant snapshot never saw). Hunt and kill them by
        // exact PID so the port frees WITHOUT falling back to another port —
        // a port move forces a tunnel restart and rotates the public URL.
        const protect = new Set<number>(
          [process.pid, serverChild?.pid, tunnelChild?.pid, adoptedTunnelPid]
            .filter((p): p is number => typeof p === "number"),
        );
        const reaped = await reapZombiePortOrphans(preferred, protect, (m) => log("INFO", m))
          .catch(() => 0);
        if (reaped > 0) await Bun.sleep(800);
      }
    }
    if (await isPortBindable(preferred, host)) return preferred;

    // Still blocked — a zombie socket Windows will not release. Pick a nearby
    // port so the backend stays up; the caller re-points the tunnel.
    for (let p = preferred + 1; p <= preferred + 20; p++) {
      if (await isPortBindable(p, host)) {
        log("WARN", `Port ${preferred} unbindable (zombie socket) — falling back to ${p}`);
        return p;
      }
    }
    log("ERROR", `No bindable port in [${preferred}, ${preferred + 20}] — keeping ${preferred}`);
    return preferred;
  }

  // ── POSIX ────────────────────────────────────────────────────────────────
  // There is no zombie-socket failure mode here: a busy port means something is
  // genuinely listening. Never move to another port — that is what silently
  // turned every extra supervisor into a full duplicate instance (7 of them,
  // each with its own public tunnel) instead of failing visibly.
  const holderPid = findPortListenerPid(preferred);
  if (holderPid > 0 && holderPid !== process.pid && isPpmProcess(holderPid)) {
    // Our own leaked server/agents from a previous generation. Reap and retry.
    log("WARN", `Port ${preferred} held by orphaned PPM process (PID ${holderPid}) — reclaiming`);
    killProcessTree(holderPid);
    await Bun.sleep(800);
    if (await isPortBindable(preferred, host)) return preferred;
  }

  log(
    "ERROR",
    holderPid > 0
      ? `Port ${preferred} is held by PID ${holderPid} and could not be reclaimed. Not falling back to another port — that would start a duplicate PPM. Run 'ppm stop', or free the port.`
      : `Port ${preferred} is unbindable and no listener could be identified. Not falling back to another port.`,
  );
  return preferred;
}

/**
 * Kill the current tunnel (child or adopted) and spawn a fresh one at `port`.
 * The trycloudflare URL will change — unavoidable, the old quick-tunnel session
 * is dead. Fire-and-forget: spawnTunnel's own loop owns liveness afterwards.
 */
function restartTunnel(port: number) {
  lastTunnelRegenAt = Date.now();
  if (tunnelChild) { try { tunnelChild.kill(); } catch {} tunnelChild = null; }
  if (adoptedTunnelPid) { try { process.kill(adoptedTunnelPid, "SIGTERM"); } catch {} adoptedTunnelPid = null; }
  tunnelUrl = null;
  if (lastSpawnMode === "named") {
    // The named URL is pinned to the configured hostname — it must never
    // flicker null mid-respawn, or every client watching status.json sees a
    // dead share link for the few seconds the connector takes to reconnect.
    updateStatus({ tunnelPid: null });
  } else {
    updateStatus({ shareUrl: null, tunnelPid: null, tunnelPort: null });
  }
  spawnTunnel(port).catch((e) => log("ERROR", `restartTunnel failed: ${e}`));
}

// ─── Server shutdown ───────────────────────────────────────────────────
// On Windows the server's Claude SDK grandchildren are node-spawned (the
// provider forces `executable: "node"`), so they live OUTSIDE Bun's job
// object. If the server child exits gracefully on its own, those
// grandchildren orphan and keep the inherited listening socket open →
// zombie port. They can only be reaped by tree-killing WHILE the parent is
// still alive, so on Windows we tree-kill immediately rather than waiting
// for a graceful self-exit (which would let the orphans escape). This
// mirrors the POSIX process-group kill used on macOS/Linux.
function requestServerShutdown(child: Subprocess, timeoutMs: number = 2000): Promise<void> {
  return new Promise<void>((resolve) => {
    const pid = child.pid;
    if (process.platform === "win32") {
      killProcessTree(pid);
      // taskkill /T can't reach descendants whose parent chain already broke
      // (orphans) — reap them from the periodic snapshot so they don't keep
      // the inherited listening-socket handle open (zombie port).
      reapTrackedDescendants((m) => log("INFO", m)).finally(() => resolve());
    } else {
      // Snapshot the tree BEFORE signalling: the Claude SDK grandchildren are
      // not in their own process group, so once the server exits they reparent
      // to init and become unfindable — while still holding the inherited
      // listening socket. That leak is what wedged the port and let a second
      // supervisor fall back to another port and run as a duplicate.
      const tree = collectProcessTree(pid);
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };

      try { child.kill("SIGTERM"); } catch {}

      const timer = setTimeout(() => {
        terminateTree(tree, 0).finally(finish);
      }, timeoutMs);

      child.exited
        .catch(() => {})
        .then(() => {
          clearTimeout(timer);
          // Even after a clean server exit the grandchildren can survive; reap
          // the snapshot regardless of how the parent went down.
          return terminateTree(tree, Math.min(timeoutMs, 2000));
        })
        .finally(finish);
    }
  });
}

// ─── Edge forwarder management ─────────────────────────────────────────
// The edge owns the PUBLIC port and forwards to the server's loopback port.
// It exists so the server never needs a stable port: cloudflared stays pinned
// to the edge, so a server port move can no longer rotate the public URL.
// The edge spawns no children, so unlike the server its listening socket can
// never be inherited and its port can never zombie.

/** Argv for re-invoking this binary (or source tree) as the edge process. */
function edgeCmd(publicPort: number, host: string): string[] {
  const args = ["__edge__", String(publicPort), host];
  return isCompiledBinary()
    ? [process.execPath, ...args]
    : [process.execPath, "run", resolve(import.meta.dir, "edge-forwarder.ts"), ...args];
}

/**
 * Spawn the edge detached so it outlives this supervisor's self-replace.
 *
 * `Bun.spawn` would tie it to the supervisor's job object on Windows and kill
 * it the moment the old supervisor exits during an upgrade — the same reason
 * spawnTunnel uses node's detached spawn. Gated on the probe mutex: fd stdio
 * enables handle inheritance, and spawning while a port probe is open would
 * hand the edge a listener handle.
 */
async function spawnEdge(publicPort: number, host: string, logFd: number): Promise<void> {
  const [bin, ...args] = edgeCmd(publicPort, host);
  const { spawn: nodeSpawn } = require("node:child_process") as typeof import("node:child_process");
  const proc = await withProbeSpawnGate(() => nodeSpawn(bin!, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", logFd] as ["ignore", "ignore", number],
  }));
  proc.unref();
  edgePid = proc.pid ?? null;
  updateStatus({ edgePid });
  log("INFO", `Edge forwarder started on ${host}:${publicPort} (PID: ${edgePid}, detached)`);
}

/**
 * Adopt an edge kept alive across an upgrade.
 *
 * Liveness alone is not proof of identity — Windows reuses PIDs, and adopting a
 * recycled PID would leave the public port unserved with the supervisor
 * believing all is well. Require that the PID is the one actually listening on
 * the public port.
 */
async function adoptEdge(publicPort: number, host: string): Promise<boolean> {
  const pid = readStatus().edgePid as number | undefined;
  if (!pid) return false;
  try {
    process.kill(pid, 0); // throws if dead
  } catch {
    log("INFO", `adoptEdge: recorded edge PID ${pid} is dead`);
    return false;
  }

  const listener = findPortListenerPid(publicPort);
  if (listener > 0 && listener !== pid) {
    log("WARN", `adoptEdge: PID ${pid} alive but port ${publicPort} is held by PID ${listener} — not adopting`);
    return false;
  }
  if (listener === 0) {
    // Listener unknown, not "absent": findPortListenerPid needs netstat on
    // Windows and lsof on POSIX, and returns 0 when the tool is missing or the
    // lookup fails. Treating that as a mismatch would refuse every adoption on
    // such a box and spawn a duplicate edge that then cannot bind. Fall back to
    // the weaker but decisive question: is anything holding the port at all?
    if (await isPortBindable(publicPort, host)) {
      log("INFO", `adoptEdge: PID ${pid} alive but port ${publicPort} is free — stale record, not adopting`);
      return false;
    }
    log("DEBUG", `adoptEdge: cannot identify the listener on ${publicPort}; port is occupied and PID ${pid} is alive — adopting`);
  }

  edgePid = pid;
  log("INFO", `Adopted existing edge forwarder (PID: ${pid}, port: ${publicPort})`);
  return true;
}

/** Respawn the edge if it dies. Without it the public port simply goes dark. */
function startEdgeProbe(publicPort: number, host: string, logFd: number) {
  if (edgeProbeTimer) return;
  edgeProbeTimer = setInterval(() => {
    if (shuttingDown || getState() === "upgrading" || !edgePid) return;
    try {
      process.kill(edgePid, 0);
    } catch {
      log("WARN", `Edge forwarder (PID: ${edgePid}) died — respawning`);
      edgePid = null;
      void spawnEdge(publicPort, host, logFd).catch((e) =>
        log("ERROR", `Edge respawn failed: ${e}`));
    }
  }, EDGE_PROBE_INTERVAL_MS);
}

/**
 * Copy the port the server published into status.json.
 *
 * Observability only — `ppm status` and the CLI health probe read it. The edge
 * reads `.server-port` directly so it never depends on this, or on the
 * supervisor being alive at all.
 */
async function mirrorServerPort(): Promise<void> {
  const deadline = Date.now() + SERVER_PORT_MIRROR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    _resetTargetCache(); // the memo is for the forwarder's hot path, not this poll
    const port = resolveTargetPort();
    if (port !== null) {
      serverPublishedPort = port;
      updateStatus({ serverPort: port });
      log("INFO", `Server bound loopback port ${port}`);
      return;
    }
    await Bun.sleep(200);
  }
  log("WARN", "Server never published its port — status.serverPort left stale");
}

/**
 * Repair `.server-port` when another process overwrites it.
 *
 * The file is the edge's routing table and lives in the shared `~/.ppm`, so
 * ANY process running the `__serve__` entry can clobber it — most easily
 * `bun dev:server`, which is not PPM_HOME-isolated and only differs by DB
 * profile. When that happens the production tunnel silently serves the dev
 * instance. The server-side guard (only a port-0, supervisor-spawned server
 * publishes) stops new writes, but a value left behind by an older build would
 * otherwise persist until the server restarts.
 *
 * After the initial handshake the supervisor knows the port its own child
 * published, so it is the authority. It still does not write the file on the
 * happy path — only to undo someone else's write.
 */
function repairServerPortFile(): void {
  if (serverPublishedPort === null || !serverChild) return;
  _resetTargetCache();
  const onDisk = resolveTargetPort();
  if (onDisk === serverPublishedPort) return;
  log(
    "WARN",
    `.server-port says ${onDisk ?? "nothing"} but our server child is on ${serverPublishedPort} — another process (a dev server?) hijacked the edge's target; restoring`,
  );
  try {
    writeFileSync(SERVER_PORT_FILE(), String(serverPublishedPort));
    _resetTargetCache();
  } catch (e) {
    log("ERROR", `Failed to restore .server-port: ${e}`);
  }
}

// ─── Server management ─────────────────────────────────────────────────
export async function spawnServer(
  serverArgs: string[],
  logFd: number,
): Promise<void> {
  // Windows: reap orphaned descendants of the previous server before binding.
  // They hold an inherited handle to the listening socket — without this the
  // new server can never bind (zombie port) and crash-loops to max_restarts.
  // No-op when nothing is tracked.
  if (process.platform === "win32") {
    await reapTrackedDescendants((m) => log("INFO", m)).catch(() => {});
  }

  // The server binds an OS-assigned loopback port (`__serve__ 0 127.0.0.1`) and
  // publishes it to `.server-port`; the edge forwards the public port to it.
  //
  // There is deliberately no port negotiation here any more. The old code
  // preferred the live tunnel's origin port and fell back to a nearby port when
  // a zombie socket held it — and that fallback re-pointed the tunnel, which is
  // what rotated the public URL on every upgrade. A server that needs no
  // particular port cannot trigger that, and cannot drift 3212→3213→3214.
  // Zombie-port handling now applies only to the edge's public port.
  //
  // Clear the stale port file so the mirror below cannot publish the previous
  // generation's port to `ppm status`, and drop our record of it so
  // repairServerPortFile does not restore a port that just died.
  serverPublishedPort = null;
  try { unlinkSync(SERVER_PORT_FILE()); } catch {}
  const cmd = isCompiledBinary()
    ? [process.execPath, ...serverArgs]
    : [process.execPath, "run", resolve(import.meta.dir, "..", "server", "index.ts"), ...serverArgs];

  // Gated: never spawn while a port probe is open (see gate).
  serverChild = await withProbeSpawnGate(() => Bun.spawn({
    cmd,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    // No visible console window. Critical on Windows after an upgrade: the new
    // supervisor is spawned consoleless (detached), so without this its console
    // children — and the Claude SDK grandchildren they spawn — pop blank windows.
    windowsHide: true,
  }));

  const childPid = serverChild.pid;
  updateStatus({ pid: childPid });
  writeFileSync(PID_FILE(), String(process.pid)); // supervisor PID for stop
  log("INFO", `Server started (PID: ${childPid})`);
  void mirrorServerPort();

  const exitCode = await serverChild.exited;
  serverChild = null;

  // Don't respawn if in stopped state (soft stop)
  if (getState() === "stopped") {
    log("INFO", "Server exited, supervisor in stopped state — not respawning");
    return;
  }

  if (exitCode === 0 && shuttingDown) {
    log("INFO", `Server exited cleanly (code ${exitCode})`);
    return;
  }

  // Exit code 42 = restart requested (e.g. /restart from Telegram)
  if (exitCode === 42 || (exitCode === 0 && !shuttingDown)) {
    log("INFO", `Server restart requested (code ${exitCode}), respawning immediately`);
    return spawnServer(serverArgs, logFd);
  }

  // SIGUSR2 restart — skip backoff, respawn immediately
  if (serverRestartRequested) {
    serverRestartRequested = false;
    log("INFO", `Server restarting (SIGUSR2), no backoff`);
    if (!shuttingDown) return spawnServer(serverArgs, logFd);
    return;
  }

  // Crash — apply backoff
  const now = Date.now();
  if (now - lastServerCrash > STABLE_WINDOW_MS) serverRestarts = 0;
  lastServerCrash = now;
  serverRestarts++;

  if (serverRestarts > MAX_RESTARTS) {
    log("WARN", `Server exceeded ${MAX_RESTARTS} restarts, pausing`);
    notifyStateChange("running", "paused", "max_restarts_exceeded");
    setState("paused");
    updateStatus({
      state: "paused",
      pid: null,
      pausedAt: new Date().toISOString(),
      pauseReason: "max_restarts",
      lastCrashError: `exit ${exitCode}`,
    });
    // Wait for resume signal — supervisor stays alive
    await waitForResume();
    // Resumed — reset and respawn
    notifyStateChange("paused", "running", "user_resume");
    setState("running");
    serverRestarts = 0;
    updateStatus({ state: "running", pausedAt: null, pauseReason: null });
    log("INFO", "Resuming server after pause");
    if (!shuttingDown) return spawnServer(serverArgs, logFd);
    return;
  }

  const delay = backoffDelay(serverRestarts);
  log("WARN", `Server crashed (exit ${exitCode}), restarting in ${delay}ms (#${serverRestarts})`);
  await Bun.sleep(delay);

  if (!shuttingDown) return spawnServer(serverArgs, logFd);
}

// ─── Tunnel management ─────────────────────────────────────────────────
const cloudflaredLogPath = () => resolve(getPpmDir(), "cloudflared.log");

/**
 * Wait for the quick-mode trycloudflare URL in the (offset-anchored) log —
 * thin wrapper over phase 2a's `waitForLogLine` so quick mode keeps its own
 * name/shape while sharing the stale-log-safe implementation with named mode.
 */
async function extractUrlFromLogFile(offset: number, getExitCode: () => number | null): Promise<string> {
  return waitForLogLine(cloudflaredLogPath(), TUNNEL_URL_REGEX, {
    fromByteOffset: offset,
    timeoutMs: 30_000,
    getExitCode,
  });
}

async function syncUrlToCloud(url: string) {
  try {
    const { sendHeartbeat, getCloudDevice } = await import("./cloud.service.ts");
    if (getCloudDevice()) {
      const ok = await sendHeartbeat(url);
      if (ok) log("INFO", `Cloud synced: ${url}`);
      else log("WARN", "Cloud sync failed (non-blocking)");
    }
  } catch {}
}

// HTTP heartbeat removed — WS is the sole heartbeat mechanism (Phase 4)

/**
 * Shared backoff-and-retry after a spawn attempt (or attempt sequence, named
 * then quick fallback) produced no usable URL. Reuses the same crash budget
 * quick-only mode always used — a persistent failure still retries forever,
 * just slower — so named mode's extra fallback attempt never changes the
 * retry cadence quick-only installs already depend on.
 */
async function retryTunnelAfterFailure(generation: number): Promise<void> {
  if (shuttingDown) return;
  const now = Date.now();
  if (now - lastTunnelCrash > STABLE_WINDOW_MS) tunnelRestarts = 0;
  lastTunnelCrash = now;
  tunnelRestarts++;
  if (tunnelRestarts > MAX_RESTARTS) tunnelRestarts = MAX_RESTARTS;
  const delay = backoffDelay(tunnelRestarts) + Math.floor(Math.random() * 1000);
  log("WARN", `Tunnel failed, retry in ${delay}ms (#${tunnelRestarts})`);
  await Bun.sleep(delay);
  if (generation !== tunnelGeneration) return; // superseded during backoff
  // Re-read the live server port: spawnServer may have moved it since this
  // attempt started, and a retry at the stale port would split-brain the tunnel.
  return spawnTunnel(_opts.port, generation);
}

/** One spawn attempt's shape — named (identity from config) or quick (identity from log regex). */
export interface TunnelAttempt {
  mode: TunnelMode;
  args: string[];
  regex: RegExp;
  urlFrom: "hostname" | "regex";
}

/**
 * Build the ordered attempt list for this spawn: named first (if configured),
 * falling back to quick — or quick-only when no named config exists. Quick's
 * argv/regex are identical whichever position it takes.
 *
 * Exported so a unit test can assert argv parity with `getQuickTunnelArgs`
 * against `spawnTunnel`'s actual call site, without spawning a real process.
 */
export function buildTunnelAttempts(config: ResolvedTunnelConfig, port: number): TunnelAttempt[] {
  const plan = chooseTunnelSpawn(config, port);
  if (plan.mode === "quick") {
    return [{ mode: "quick", args: plan.args, regex: TUNNEL_URL_REGEX, urlFrom: "regex" }];
  }
  return [
    { mode: "named", args: plan.args, regex: NAMED_TUNNEL_READY_REGEX, urlFrom: "hostname" },
    { mode: "quick", args: getQuickTunnelArgs(port), regex: TUNNEL_URL_REGEX, urlFrom: "regex" },
  ];
}

/**
 * Decide the `tunnelWarning` field (if any) for a spawnTunnel success write.
 *
 * - `downgraded` (named was attempted first but failed, quick succeeded as
 *   THIS spawn's fallback) is the only case a spawn ever WRITES a warning —
 *   that text must persist until the user acts, so it is the sole owner here.
 * - A quick success that was NOT a downgrade means the persisted config
 *   itself resolved to quick outright (`attempts` was quick-only) — whether
 *   that spawn was triggered by a deliberate retunnel-to-quick, a cold boot,
 *   or any later regen while quick stays configured, it reconfirms the user
 *   is no longer on named mode, so any warning left over from before they
 *   switched (e.g. a stale "hostname unreachable") no longer applies.
 * - A plain named success (not a downgrade) never touches the warning —
 *   clearing a NAMED-mode warning is exclusively the probe's job once it
 *   confirms the hostname is actually reachable (`named-tunnel-probe-state.ts`).
 */
export function tunnelWarningPatchForSpawnSuccess(
  successfulMode: TunnelMode,
  downgraded: boolean,
): { tunnelWarning: string | null } | Record<string, never> {
  if (downgraded) {
    return { tunnelWarning: "Named tunnel failed to start — using a temporary quick URL" };
  }
  if (successfulMode === "quick") {
    return { tunnelWarning: null };
  }
  return {};
}

export async function spawnTunnel(port: number, generation: number = ++tunnelGeneration): Promise<void> {
  tunnelPort = port; // remember origin port so resume/port-move can re-point
  // Refresh the cached config here (not just at startup) — a fresh named
  // setup, disable, or token rotation since the last spawn must be picked up
  // before deciding what to spawn next.
  namedTunnelMode = await readTunnelConfigFresh();

  let bin: string;
  try {
    const { ensureCloudflared } = await import("./cloudflared.service.ts");
    bin = await ensureCloudflared();
  } catch (err) {
    log("ERROR", `Failed to get cloudflared: ${err}`);
    return;
  }

  const attempts = buildTunnelAttempts(namedTunnelMode, port);
  const logPath = cloudflaredLogPath();
  // Truncate stale content from a prior generation; best-effort — Windows can
  // silently fail this while a previous detached cloudflared still holds the
  // file open, which is exactly why every readiness read below is anchored to
  // a byte offset captured AFTER this attempt rather than trusting the file
  // to actually be empty.
  try { unlinkSync(logPath); } catch {}

  // ── Windows: spawn detached + windowless via node:child_process ────────
  // Bun.spawn ties children to the supervisor's job object, so the tunnel
  // would be killed the moment the OLD supervisor exits during a self-replace
  // upgrade — the new supervisor then finds a dead PID, spawns a fresh tunnel,
  // and the trycloudflare URL changes on every upgrade. node's detached spawn
  // (+ unref) escapes the job object so cloudflared outlives the swap and the
  // new supervisor adopts it by PID — the macOS/Linux behaviour (orphaning)
  // achieved explicitly. windowsHide stops a blank console window appearing
  // when the supervisor itself was started consoleless by the upgrade path.
  if (process.platform === "win32") {
    const { spawn: nodeSpawn } = require("node:child_process") as typeof import("node:child_process");

    let winPid: number | null = null;
    let successfulMode: TunnelMode | null = null;
    let resolvedUrl: string | null = null;
    let downgraded = false;

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]!;
      const offset = existsSync(logPath) ? statSync(logPath).size : 0;
      const attemptLogFd = openSync(logPath, "a");
      // Gated: fd stdio enables handle inheritance — spawning while a port
      // probe is open would hand cloudflared the listener handle (see gate).
      const proc = await withProbeSpawnGate(() => nodeSpawn(bin, attempt.args, {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", attemptLogFd] as ["ignore", "ignore", number],
      }));
      proc.unref();
      try { closeSync(attemptLogFd); } catch {} // child keeps its own fd
      const pid = proc.pid ?? null;

      try {
        const matched = attempt.urlFrom === "hostname"
          ? await waitForLogLine(logPath, attempt.regex, {
              fromByteOffset: offset, timeoutMs: 30_000, getExitCode: () => proc.exitCode,
            }).then(() => `https://${namedTunnelMode!.hostname}`)
          : await extractUrlFromLogFile(offset, () => proc.exitCode);
        tunnelUrl = matched;
        resolvedUrl = matched;
        winPid = pid;
        successfulMode = attempt.mode;
        downgraded = i > 0;
        break;
      } catch (err) {
        log("ERROR", `${attempt.mode} tunnel failed to start: ${err}`);
        try { if (pid) process.kill(pid, "SIGKILL"); } catch {}
        tunnelUrl = null;
        if (generation !== tunnelGeneration) return; // superseded — don't bother with the next attempt
      }
    }

    if (winPid === null || !successfulMode || resolvedUrl === null) {
      return retryTunnelAfterFailure(generation);
    }

    // A newer authoritative (re)start superseded us while we extracted the URL —
    // don't register as the live tunnel; kill our now-orphan child and bail.
    if (generation !== tunnelGeneration) {
      try { process.kill(winPid, "SIGKILL"); } catch {}
      return;
    }

    // The detached tunnel is independent of this supervisor, so there is no
    // `.exited` promise to await for crash detection. Model it as adopted from
    // the start: the tunnel probe (startTunnelProbe) owns liveness + respawn.
    adoptedTunnelPid = winPid;
    tunnelChild = null;
    lastSpawnMode = successfulMode;
    // `namedProbeRestartAttempted` is deliberately NOT touched here — see the
    // probe's `decideNamedProbeAction` state machine. A successful spawn only
    // proves cloudflared reconnected to Cloudflare's edge, not that the
    // configured hostname actually routes to it (that's a DNS/CNAME concern
    // the probe alone can verify), so a bare respawn success must not re-arm
    // the one-restart budget or the CNAME-deleted case would restart forever.
    updateStatus({
      shareUrl: resolvedUrl, tunnelPid: winPid, tunnelPort: port,
      tunnelMode: successfulMode,
      ...tunnelWarningPatchForSpawnSuccess(successfulMode, downgraded),
    });
    log("INFO", `Tunnel ready: ${resolvedUrl} (PID: ${winPid}, detached${downgraded ? ", downgraded from named" : ""})`);
    await syncUrlToCloud(resolvedUrl);
    return;
  }

  // ── POSIX ────────────────────────────────────────────────────────────────
  // Under systemd, wrap tunnel in a transient user scope so it lives in its
  // own cgroup instead of ppm.service. This prevents systemd from SIGKILLing
  // the tunnel when ppm.service cgroup is torn down during upgrade/restart,
  // preserving the tunnel URL across the new supervisor.
  // INVOCATION_ID is set by systemd; absence means we're not under systemd.
  const underSystemd = !!process.env.INVOCATION_ID && process.platform === "linux";
  const buildCmd = (args: string[]): string[] =>
    underSystemd
      ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--", bin, ...args]
      : [bin, ...args];

  let child: Subprocess | null = null;
  let successfulMode: TunnelMode | null = null;
  let resolvedUrl: string | null = null;
  let downgraded = false;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    const offset = existsSync(logPath) ? statSync(logPath).size : 0;
    const attemptLogFd = openSync(logPath, "a");
    // Own this cloudflared via a LOCAL ref for the whole loop. `tunnelChild` is
    // a mutable global that a concurrent restartTunnel() nulls/reassigns;
    // awaiting `tunnelChild.exited` on it would throw mid-flight, killing this
    // loop WITHOUT reaping the child we spawned — orphaned cloudflared. The
    // local ref keeps lifecycle self-contained; only touch the global when it
    // still points at us.
    let attemptChild: Subprocess;
    try {
      attemptChild = await withProbeSpawnGate(() =>
        Bun.spawn(buildCmd(attempt.args), { stderr: attemptLogFd, stdout: "ignore", stdin: "ignore" }));
      tunnelChild = attemptChild; // publish so restartTunnel/killStaleTunnel can reach the live child
    } finally {
      try { closeSync(attemptLogFd); } catch {} // cloudflared keeps its own via dup2
    }
    if (underSystemd && i === 0) log("INFO", "Tunnel spawned inside transient systemd-run scope (escapes ppm.service cgroup)");

    try {
      const matched = attempt.urlFrom === "hostname"
        ? await waitForLogLine(logPath, attempt.regex, {
            fromByteOffset: offset, timeoutMs: 30_000, getExitCode: () => attemptChild.exitCode,
          }).then(() => `https://${namedTunnelMode!.hostname}`)
        : await extractUrlFromLogFile(offset, () => attemptChild.exitCode);
      tunnelUrl = matched;
      resolvedUrl = matched;
      child = attemptChild;
      successfulMode = attempt.mode;
      downgraded = i > 0;
      break;
    } catch (err) {
      log("ERROR", `${attempt.mode} tunnel failed to start: ${err}`);
      try { attemptChild.kill(); } catch {}
      if (tunnelChild === attemptChild) tunnelChild = null;
      tunnelUrl = null;
      if (generation !== tunnelGeneration) return; // superseded — don't bother with the next attempt
    }
  }

  if (!child || !successfulMode || resolvedUrl === null) {
    return retryTunnelAfterFailure(generation);
  }

  // A newer authoritative (re)start superseded us while we extracted the URL —
  // kill our child so it can't linger as an orphan, and bail.
  if (generation !== tunnelGeneration) {
    try { child.kill(); } catch {}
    if (tunnelChild === child) tunnelChild = null;
    return;
  }

  lastSpawnMode = successfulMode;
  // `namedProbeRestartAttempted` is deliberately NOT touched here — see the
  // probe's `decideNamedProbeAction` state machine and the win32 branch above
  // for why a bare spawn success must never re-arm the one-restart budget.
  updateStatus({
    shareUrl: resolvedUrl, tunnelPid: child.pid, tunnelPort: port,
    tunnelMode: successfulMode,
    ...tunnelWarningPatchForSpawnSuccess(successfulMode, downgraded),
  });
  log("INFO", `Tunnel ready: ${resolvedUrl} (PID: ${child.pid}${downgraded ? ", downgraded from named" : ""})`);

  // One-time sync of tunnel URL to cloud (WS handles periodic heartbeat)
  await syncUrlToCloud(resolvedUrl);

  const exitCode = await child.exited;
  if (tunnelChild === child) tunnelChild = null;
  const deadUrl = tunnelUrl;
  tunnelUrl = null;

  if (shuttingDown) return;

  // A newer authoritative (re)start (restartTunnel / probe regen) superseded us
  // while our child was alive — do NOT respawn, or two concurrent loops would
  // run and leak orphaned cloudflared processes.
  if (generation !== tunnelGeneration) {
    log("INFO", `Tunnel loop gen ${generation} superseded by gen ${tunnelGeneration}, exiting without respawn`);
    return;
  }

  log("WARN", `Tunnel process exited (code=${exitCode}, url=${deadUrl}), applying backoff`);
  return retryTunnelAfterFailure(generation);
}

// ─── Health checks ─────────────────────────────────────────────────────
function startServerHealthCheck() {
  healthTimer = setInterval(async () => {
    if (shuttingDown || getState() === "stopped") return;
    // The spawn loop can stall before ever producing a child, leaving supervisor
    // and tunnel healthy while nothing serves — invisible to every other probe.
    // Crash backoff also parks serverChild at null, but never longer than
    // BACKOFF_MAX_MS, so only revive past that margin.
    if (!serverChild) {
      if (getState() !== "running") return;
      noServerChildCycles++;
      if (noServerChildCycles * SERVER_HEALTH_INTERVAL_MS >= SERVER_REVIVE_AFTER_MS) {
        noServerChildCycles = 0;
        log("WARN", "No server child while state=running — reviving server");
        spawnServer(_serverArgs, _logFd).catch((e) => log("ERROR", `Server revive failed: ${e}`));
      }
      return;
    }
    noServerChildCycles = 0;
    // Undo any foreign write to `.server-port` before reading it, or the probe
    // below would health-check a dev server and report our own as fine while
    // the public tunnel serves the wrong instance.
    repairServerPortFile();
    // Probe the SERVER's own loopback port, never `_opts.port` — that is the
    // public port and belongs to the edge. Probing through the edge would make
    // a dead edge look like a dead server and kill a perfectly healthy one
    // every third cycle. Edge liveness is startEdgeProbe's job.
    _resetTargetCache();
    const checkPort = resolveTargetPort();
    if (checkPort === null) {
      // Server has not published a port yet (still booting, or just respawned).
      // Absence of a port is not evidence of ill health.
      healthFailCount = 0;
      return;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${checkPort}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) { healthFailCount = 0; return; }
    } catch {}
    healthFailCount++;
    if (healthFailCount >= SERVER_HEALTH_FAIL_THRESHOLD && serverChild) {
      log("WARN", `Server unresponsive (${healthFailCount} failures), killing`);
      const pid = serverChild.pid;
      if (process.platform === "win32") {
        killProcessTree(pid);
        // Reap broken-chain orphans too, or the respawned server can't bind the port
        await reapTrackedDescendants((m) => log("INFO", m));
      } else {
        try { serverChild.kill("SIGTERM"); } catch {}
        setTimeout(() => { killProcessTree(pid); }, 1000).unref();
      }
      healthFailCount = 0;
      // spawnServer loop handles respawn via exited promise
    }
  }, SERVER_HEALTH_INTERVAL_MS);
}

/**
 * Named-mode identity probe: fetch the public hostname's health and our own
 * loopback health, then compare `instanceId`. A mismatch means someone else's
 * connector is answering our hostname (treat as unreachable, same as a fetch
 * failure); this is what lets a dead-but-adopted named connector be told apart
 * from a live one that Cloudflare has quietly repointed. Falls back to a bare
 * reachability check when either side omits `instanceId` (older server build,
 * or the loopback port isn't resolvable yet) rather than hard-failing.
 */
async function probeNamedTunnelHealth(): Promise<boolean> {
  try {
    const publicRes = await fetch(`${tunnelUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!publicRes.ok) return false;
    _resetTargetCache();
    const checkPort = resolveTargetPort();
    if (checkPort === null) return true; // can't compare identity yet — reachability alone is enough for now
    const publicBody = await publicRes.json().catch(() => null) as { data?: { instanceId?: unknown } } | null;
    const localRes = await fetch(`http://127.0.0.1:${checkPort}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!localRes.ok) return true; // our own server's health is startServerHealthCheck's job, not this probe's
    const localBody = await localRes.json().catch(() => null) as { data?: { instanceId?: unknown } } | null;
    const publicId = publicBody?.data?.instanceId;
    const localId = localBody?.data?.instanceId;
    if (typeof publicId === "string" && typeof localId === "string") return publicId === localId;
    return true; // instanceId not yet present on either side — reachability only
  } catch {
    return false;
  }
}

function startTunnelProbe() {
  tunnelProbeTimer = setInterval(async () => {
    if (shuttingDown || !tunnelUrl) { tunnelFailCount = 0; return; }
    if (!tunnelChild && !adoptedTunnelPid) { tunnelFailCount = 0; return; }
    // Don't probe when server is intentionally stopped (stopped page serves 503)
    if (getState() === "stopped") { tunnelFailCount = 0; return; }

    // Check if adopted tunnel process is still alive
    if (adoptedTunnelPid && !tunnelChild) {
      try { process.kill(adoptedTunnelPid, 0); } catch {
        log("WARN", "Adopted tunnel process died, respawning");
        adoptedTunnelPid = null;
        tunnelUrl = null;
        // Named URL is pinned — don't flicker it null for the brief respawn window.
        updateStatus(lastSpawnMode === "named" ? { tunnelPid: null } : { shareUrl: null, tunnelPid: null });
        tunnelFailCount = 0;
        spawnTunnel(_opts.port); // live server port, not the startup config port
        return;
      }
    }

    // Skip the URL health probe while the server isn't actually running
    // (crash-loop backoff, paused after max_restarts). The tunnel can't be
    // healthy without an origin — regenerating it would just rotate the URL
    // on every probe window while the real problem is the server.
    if (getState() !== "running" || !serverChild) { tunnelFailCount = 0; return; }

    if (lastSpawnMode === "named") {
      const healthy = await probeNamedTunnelHealth();
      // All state transitions for the restart-once-then-warn budget live in
      // this pure helper — the ONLY place `restartAttempted` (and the
      // warning) is ever cleared is a confirmed-healthy observation here,
      // never a bare spawn success (see spawnTunnel's success writes).
      const { action, nextState } = decideNamedProbeAction(
        healthy,
        { failCount: tunnelFailCount, restartAttempted: namedProbeRestartAttempted },
        TUNNEL_ZOMBIE_THRESHOLD,
      );
      tunnelFailCount = nextState.failCount;
      namedProbeRestartAttempted = nextState.restartAttempted;

      switch (action.type) {
        case "healthy":
          tunnelRestarts = 0;
          // Only write when there's actually a warning to clear — otherwise
          // this fires every healthy 30s tick forever (tmp-write + rename on
          // every single cycle) even though nothing ever changes.
          if (readStatus().tunnelWarning != null) updateStatus({ tunnelWarning: null });
          return;
        case "watch":
          return;
        case "restart-once":
          log("WARN", "Named tunnel unreachable at threshold — restarting the connector once");
          if (tunnelChild) {
            try { tunnelChild.kill(); } catch {}
            // spawnTunnel loop handles respawn via exited promise
          } else if (adoptedTunnelPid) {
            try { process.kill(adoptedTunnelPid, "SIGTERM"); } catch {}
            adoptedTunnelPid = null;
            spawnTunnel(_opts.port); // live server port, not the startup config port
          }
          return;
        case "warn-and-stop":
          // Already tried a restart — the hostname is still dark. Never loop
          // further and never null the pinned URL; just surface the warning.
          log("WARN", "Named tunnel still unreachable after one restart — warning and stopping (shareUrl stays pinned)");
          updateStatus({ tunnelWarning: "hostname unreachable — check DNS/Cloudflare" });
          return;
      }
      return;
    }

    // Quick mode: existing zombie-regen behavior, unchanged.
    const healthy = await fetch(`${tunnelUrl}/api/health`, { signal: AbortSignal.timeout(10_000) })
      .then((res) => res.ok).catch(() => false);
    if (healthy) {
      tunnelFailCount = 0;
      tunnelRestarts = 0;
      return;
    }
    tunnelFailCount++;
    if (tunnelFailCount < TUNNEL_ZOMBIE_THRESHOLD) return;
    log("WARN", `Tunnel URL zombie (${tunnelFailCount} fails ≈ ${tunnelFailCount * (TUNNEL_PROBE_INTERVAL_MS / 1000)}s, process alive but edge dropped), regenerating`);
    if (tunnelChild) {
      try { tunnelChild.kill(); } catch {}
      // spawnTunnel loop handles respawn via exited promise
    } else if (adoptedTunnelPid) {
      try { process.kill(adoptedTunnelPid, "SIGTERM"); } catch {}
      adoptedTunnelPid = null;
      tunnelUrl = null;
      updateStatus({ shareUrl: null, tunnelPid: null });
      spawnTunnel(_opts.port); // live server port, not the startup config port
    }
    tunnelFailCount = 0;
  }, TUNNEL_PROBE_INTERVAL_MS);
}

// ─── Upgrade check ──────────────────────────────────────────────────────
async function checkAvailableVersion() {
  try {
    const { checkForUpdate } = await import("./upgrade.service.ts");
    const result = await checkForUpdate();
    if (result.available && result.latest) {
      updateStatus({ availableVersion: result.latest });
      log("INFO", `New version available: ${result.latest} (current: ${result.current})`);
    } else {
      updateStatus({ availableVersion: null });
    }
  } catch (e) {
    log("WARN", `Upgrade check failed: ${e}`);
  }
}

/** Try to adopt an existing tunnel process from status.json (survives upgrade) */
function adoptTunnel(): boolean {
  try {
    const status = readStatus();
    const pid = status.tunnelPid as number;
    const url = status.shareUrl as string;
    if (!pid || !url) {
      log("DEBUG", `adoptTunnel: missing tunnelPid(${pid}) or shareUrl(${url}) in status`);
      return false;
    }
    process.kill(pid, 0); // throws if process is dead
    // Liveness alone is not proof of identity — Windows/Linux both reuse PIDs,
    // and a recycled PID happening to belong to some unrelated process would
    // get "adopted" as the tunnel while the real one (if any) sits orphaned.
    if (!isCloudflaredPid(pid)) {
      log("WARN", `adoptTunnel: PID ${pid} is alive but its executable is not cloudflared — refusing to adopt`);
      return false;
    }
    // Named mode's URL is pinned to the configured hostname. A stale quick URL
    // left over from before named was configured (or from a downgrade) must
    // never be adopted as if it were the named tunnel.
    if (namedTunnelMode?.mode === "named") {
      const expected = `https://${namedTunnelMode.hostname}`;
      if (url !== expected) {
        log("WARN", `adoptTunnel: status.shareUrl ${url} does not match configured named hostname ${expected} — refusing to adopt`);
        return false;
      }
    }
    adoptedTunnelPid = pid;
    tunnelUrl = url;
    // Remember which origin port the adopted tunnel targets so spawnServer can
    // bind THERE (not the configured port) and keep the public URL alive.
    if (typeof status.tunnelPort === "number") tunnelPort = status.tunnelPort;
    if (typeof status.tunnelMode === "string") lastSpawnMode = status.tunnelMode as TunnelMode;
    log("INFO", `Adopted existing tunnel (PID: ${pid}, URL: ${url}, origin port: ${tunnelPort ?? "unknown"}, mode: ${lastSpawnMode})`);
    return true;
  } catch (e) {
    log("WARN", `adoptTunnel: tunnel PID ${(readStatus().tunnelPid)} unreachable: ${e}`);
    return false;
  }
}

/** Kill stale tunnel PID from status.json (cleanup after failed adoption) */
function killStaleTunnel() {
  try {
    const status = readStatus();
    const pid = status.tunnelPid as number;
    if (!pid) return;
    try { process.kill(pid, "SIGTERM"); } catch {}
    log("INFO", `Killed stale tunnel (PID: ${pid})`);
  } catch {}
  updateStatus({ tunnelPid: null, shareUrl: null });
}

/**
 * `pgrep -f` pattern matching PPM's own cloudflared, running EITHER mode's
 * long-lived connector. `.*` spans the `--config <path>`/`--origincert` args
 * between bin and `tunnel`. Deliberately does NOT match `tunnel
 * login`/`create`/`route`/`token` — those are short-lived management
 * subcommands the reaper must never SIGTERM mid-flight. Exported so a unit
 * test can assert the match/exclude set without shelling out to pgrep.
 */
export function orphanedTunnelPgrepPattern(bin: string): string {
  return `${bin}.*tunnel (run|--url)`;
}

/** Reap orphaned cloudflared processes left by crashed supervisors or stale
 *  spawn loops. Matches PPM's own cloudflared bin path and SIGTERMs every match
 *  except `keepPid`. POSIX only — on win32 the tunnel is tied to the job object
 *  and torn down with the supervisor. status.json tracks only the newest PID,
 *  so untracked orphans accumulate and saturate the network, false-triggering
 *  zombie regeneration; this sweeps them on startup. */
async function reapOrphanedTunnels(keepPid: number | null): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const { getCloudflaredPath } = await import("./cloudflared.service.ts");
    const bin = getCloudflaredPath();
    const res = Bun.spawnSync(["pgrep", "-f", orphanedTunnelPgrepPattern(bin)]);
    // pgrep exits 1 when nothing matches — not an error.
    const pids = new TextDecoder().decode(res.stdout)
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((p) => Number.isInteger(p) && p !== keepPid && p !== process.pid);
    let killed = 0;
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); killed++; } catch {}
    }
    if (killed > 0) {
      log("INFO", `Reaped ${killed} orphaned cloudflared process(es) (kept ${keepPid ?? "none"})`);
    }
  } catch (e) {
    log("WARN", `reapOrphanedTunnels failed: ${e}`);
  }
}

/** Spawn new supervisor from updated code, wait for it to be healthy, then exit */
async function selfReplace(): Promise<{ success: boolean; error?: string }> {
  log("INFO", "Starting self-replace for upgrade");
  const underSystemd = !!process.env.INVOCATION_ID && process.platform === "linux";
  // launchd sets XPC_SERVICE_NAME to the job label. Same situation as systemd:
  // spawning a detached replacement is invisible to the service manager, so
  // when we exit it respawns its OWN supervisor on top of the replacement —
  // two live instances per upgrade, which is how 7 accumulated.
  const underLaunchd =
    process.platform === "darwin" && process.env.XPC_SERVICE_NAME === PLIST_LABEL;
  const currentSupervisorPid = process.pid;

  try {
    // Prevent spawnServer crash-restart loop from respawning killed children
    shuttingDown = true;
    notifyStateChange(getState(), "upgrading", "self_replace");
    setState("upgrading");
    updateStatus({ state: "upgrading" });

    // Diagnostic: snapshot the tunnel state being handed to the new supervisor.
    // The new supervisor can only keep the public URL if this pid/url is still
    // alive and gets preserved in status.json (state must stay "upgrading").
    log("INFO", `Self-replace: tunnel handoff pid=${adoptedTunnelPid ?? tunnelChild?.pid ?? null} url=${tunnelUrl}`);

    // Set restarting flag so server child's stopTunnel() skips killing the tunnel
    try { writeFileSync(restartingFlag(), ""); } catch {}

    // Clear probe timer FIRST to prevent race between flush check and queued callback
    if (tunnelProbeTimer) { clearInterval(tunnelProbeTimer); tunnelProbeTimer = null; }

    // Final tunnel liveness check before handing off to new supervisor —
    // if the adopted tunnel died since the last probe, clear status so the
    // new supervisor spawns fresh instead of discovering ESRCH.
    if (adoptedTunnelPid && !tunnelChild) {
      try {
        process.kill(adoptedTunnelPid, 0);
        log("INFO", `Pre-upgrade: adopted tunnel ${adoptedTunnelPid} alive — preserving across upgrade`);
      } catch {
        log("WARN", "Pre-upgrade: adopted tunnel dead, clearing for new supervisor to spawn fresh");
        adoptedTunnelPid = null;
        tunnelUrl = null;
        updateStatus({ shareUrl: null, tunnelPid: null });
      }
    }

    // Kill server child to free the port; keep tunnel alive for domain continuity
    log("INFO", "Stopping server before upgrade (tunnel kept alive)");
    if (serverChild) {
      // requestServerShutdown reaps the whole descendant tree on both platforms.
      // The old `kill(-pid)` here never worked: the server is not a process
      // group leader, so the group kill hit ESRCH and the agents survived.
      await requestServerShutdown(serverChild, 2000);
      serverChild = null;
    }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }

    // ── Service-manager path: exit cleanly, let the manager bring us back ──
    // The old approach (spawn a detached replacement + hand off) makes the
    // manager lose track of us: systemd reports "not our child" and dies on
    // daemon-reload, launchd's KeepAlive respawns a second supervisor on top of
    // the replacement. Instead, just exit — the manager restarts us with the
    // new code, as exactly one process.
    if (underSystemd || underLaunchd) {
      log("INFO", `Under ${underSystemd ? "systemd" : "launchd"}: exiting for automatic restart with updated code`);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (upgradeCheckTimer) clearInterval(upgradeCheckTimer);
      if (upgradeDelayTimer) clearTimeout(upgradeDelayTimer);
      if (cloudMonitorTimer) clearInterval(cloudMonitorTimer);
      // Disconnect Cloud WS so new supervisor can reconnect cleanly
      try { const { disconnect } = await import("./cloud-ws.service.ts"); disconnect(); } catch {}
      // Don't kill the tunnel — it lives in its own systemd-run scope / detached
      // session, so it survives teardown and the restarted supervisor adopts it
      // (status.json still says "upgrading", which preserves the public URL).
      process.exit(0);
    }

    // ── Unmanaged path: spawn new supervisor directly (bare `ppm start`) ─
    // Poll until port is actually free (max 10s) — never guess with fixed sleep.
    // The tree-kill above already reaped the server's grandchildren, so the
    // listening socket is released; this loop just waits for the OS to finish
    // tearing it down before the new supervisor binds.
    // Only relevant when NO edge is running — i.e. migrating from a pre-edge
    // build where the server itself held the public port. With an edge alive
    // the port is legitimately occupied by it and the new supervisor adopts it;
    // waiting for the port to free would time out, and the tree-kill below
    // would murder the edge and rotate the public URL — the exact failure this
    // whole design removes.
    if (!edgePid) {
      const portFreeStart = Date.now();
      const portTimeout = process.platform === "win32" ? 3_000 : 10_000;
      while (Date.now() - portFreeStart < portTimeout) {
        const inUse = !(await isPortBindable(_opts.port, _opts.host));
        if (!inUse) break;
        log("DEBUG", `Port ${_opts.port} still in use, waiting...`);
        await Bun.sleep(200);
      }

      // Windows: the tracked-descendant snapshot can miss an orphan (an SDK
      // grandchild spawned after the last snapshot, or whose parent chain already
      // broke). If it still holds the inherited listening socket, the new
      // supervisor can never bind. Resolve the real holder via netstat and
      // tree-kill it so the handoff doesn't dead-end on a zombie port.
      if (process.platform === "win32") {
        const stillInUse = !(await isPortBindable(_opts.port, _opts.host));
        if (stillInUse) {
          const holderPid = findPortListenerPid(_opts.port);
          if (holderPid > 0) {
            log("WARN", `Port ${_opts.port} still held by PID ${holderPid} before self-replace — tree-killing`);
            killProcessTree(holderPid);
            await Bun.sleep(500);
          }
        }
      }
    } else {
      log("INFO", `Edge forwarder (PID: ${edgePid}) holds port ${_opts.port} — leaving it for the new supervisor to adopt`);
    }

    // Spawn new supervisor using saved argv
    const cmd = originalArgv.slice();
    const newLogFd = openSync(logFile(), "a");

    // detached:true is what makes the replacement independent of us: a new job
    // object on Windows, a new session on POSIX. Without the POSIX session,
    // launchd/systemd tears the replacement down along with our process group
    // the moment we exit — it dies seconds after adopting the tunnel.
    const { spawn: nodeSpawn } = require("node:child_process") as typeof import("node:child_process");
    // Gated: never spawn while a port probe is open (see gate).
    const proc = await withProbeSpawnGate(() => nodeSpawn(cmd[0]!, cmd.slice(1), {
      detached: true,
      stdio: ["ignore", newLogFd, newLogFd] as any,
      env: process.env as NodeJS.ProcessEnv,
      windowsHide: true,
    }));
    const killNewChild = () => { try { if (proc.pid) process.kill(proc.pid); } catch {} };
    proc.unref();
    try { closeSync(newLogFd); } catch {} // child inherited fd, parent can close

    // Poll status.json for new supervisor PID (up to 30s)
    const start = Date.now();
    while (Date.now() - start < SELF_REPLACE_TIMEOUT_MS) {
      await Bun.sleep(1000);
      try {
        const data = JSON.parse(readFileSync(STATUS_FILE(), "utf-8"));
        if (data.supervisorPid && data.supervisorPid !== currentSupervisorPid) {
          log("INFO", `New supervisor detected (PID: ${data.supervisorPid}), handing off MainPID to systemd`);
          await sdNotify(`MAINPID=${data.supervisorPid}`);
          await Bun.sleep(300);
          log("INFO", `Old supervisor exiting`);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          if (upgradeCheckTimer) clearInterval(upgradeCheckTimer);
          if (upgradeDelayTimer) clearTimeout(upgradeDelayTimer);
          process.exit(0);
        }
      } catch {}
    }

    // Timeout — new supervisor didn't start, restore old supervisor
    log("ERROR", "Self-replace timeout: new supervisor did not start");
    killNewChild();
    try { unlinkSync(restartingFlag()); } catch {}
    shuttingDown = false;
    notifyStateChange("upgrading", "running", "upgrade_failed");
    setState("running");
    updateStatus({ state: "running" });
    return { success: false, error: "New supervisor failed to start within 30s" };
  } catch (e) {
    log("ERROR", `Self-replace error: ${e}`);
    try { unlinkSync(restartingFlag()); } catch {}
    shuttingDown = false;
    notifyStateChange("upgrading", "running", "upgrade_failed");
    setState("running");
    updateStatus({ state: "running" });
    return { success: false, error: (e as Error).message };
  }
}

// ─── Cloud WS integration ─────────────────────────────────────────────

/** Notify Cloud of supervisor state change via WS */
async function notifyStateChange(from: string, to: string, reason: string) {
  try {
    const { send, isConnected } = await import("./cloud-ws.service.ts");
    if (isConnected()) {
      send({
        type: "state_change",
        from,
        to,
        reason,
        timestamp: new Date().toISOString(),
      });
    }
  } catch {}
}

/** Connect supervisor to Cloud via WebSocket (if device is linked) */
async function connectCloud(opts: { port: number }, serverArgs: string[], logFd: number): Promise<boolean> {
  try {
    const { getCloudDevice, saveCloudDevice } = await import("./cloud.service.ts");
    const device = getCloudDevice();
    if (!device) return false; // not linked to cloud

    const { connect, onCommand } = await import("./cloud-ws.service.ts");
    const { VERSION } = await import("../version.ts");
    // Import getConfigValue for fresh SQLite reads — supervisor's in-memory configService
    // is a separate process singleton and won't see changes made by the server process.
    const { getConfigValue } = await import("./db.service.ts");
    const startTime = Date.now();

    connect({
      cloudUrl: device.cloud_url,
      deviceId: device.device_id,
      secretKey: device.secret_key,
      heartbeatFn: () => {
        const status = readStatus();
        // Re-read device file each heartbeat to pick up name changes
        const currentDevice = getCloudDevice();
        // Read device_name fresh from SQLite — configService.get() is stale in the supervisor
        // process (server process writes to SQLite but can't update supervisor's in-memory cache).
        let configName = "";
        try {
          const raw = getConfigValue("device_name");
          if (raw) configName = JSON.parse(raw) || "";
        } catch {}
        if (configName && currentDevice && configName !== currentDevice.name) {
          currentDevice.name = configName;
          saveCloudDevice(currentDevice);
        }
        return {
          type: "heartbeat" as const,
          tunnelUrl,
          state: getState(),
          // Use server-reported version (source of truth) with supervisor fallback
          appVersion: (status.serverVersion as string) || VERSION,
          availableVersion: (status.availableVersion as string) || null,
          serverPid: serverChild?.pid ?? null,
          uptime: Math.floor((Date.now() - startTime) / 1000),
          deviceName: currentDevice?.name ?? device.name,
          timestamp: new Date().toISOString(),
        };
      },
    });

    // Handle commands from Cloud
    onCommand(async (cmd) => {
      const { send } = await import("./cloud-ws.service.ts");
      const sendResult = (success: boolean, error?: string, data?: Record<string, unknown>) => {
        send({
          type: "command_result",
          id: cmd.id,
          success,
          error,
          data,
          timestamp: new Date().toISOString(),
        });
      };

      log("INFO", `Cloud command received: ${cmd.action}`);

      // Send immediate ack so Cloud can update UI before processing
      send({
        type: "command_ack",
        id: cmd.id,
        timestamp: new Date().toISOString(),
      });

      switch (cmd.action) {
        case "start":
          if (getState() === "stopped") {
            triggerResume();
            sendResult(true, undefined, { state: "running" });
          } else {
            sendResult(false, `Server already in ${getState()} state`);
          }
          break;

        case "restart":
          if (serverChild) {
            serverRestartRequested = true;
            // Tree-kill (not single-PID kill): on Windows orphaned SDK
            // grandchildren keep the inherited listening-socket handle open
            // and the respawned server can never bind (zombie port).
            requestServerShutdown(serverChild).catch(() => {});
            sendResult(true);
          } else if (getState() === "paused" || getState() === "stopped") {
            triggerResume();
            sendResult(true);
          } else {
            sendResult(false, "No server child to restart");
          }
          break;

        case "resume":
          if (getState() === "paused" || getState() === "stopped") {
            triggerResume();
            sendResult(true);
          } else {
            sendResult(false, `Not in paused/stopped state (current: ${getState()})`);
          }
          break;

        case "stop":
          if (getState() === "stopped") {
            sendResult(false, "Already stopped");
          } else {
            sendResult(true);
            softStop();
          }
          break;

        case "shutdown":
          sendResult(true);
          setTimeout(() => {
            shutdown();
            process.exit(0);
          }, 500);
          break;

        case "status":
          sendResult(true, undefined, {
            state: getState(),
            serverPid: serverChild?.pid ?? null,
            tunnelUrl,
            serverRestarts,
            stoppedAt: getState() === "stopped"
              ? readStatus().stoppedAt
              : null,
          });
          break;

        default:
          sendResult(false, `Unknown action: ${cmd.action}`);
      }
    });
    cloudConnected = true;
    return true;
  } catch (e) {
    log("WARN", `Cloud WS setup failed: ${e}`);
    return false;
  }
}

/** Periodically check if cloud-device.json appeared/disappeared and connect/disconnect */
function startCloudMonitor(opts: { port: number }, serverArgs: string[], logFd: number) {
  const CLOUD_MONITOR_INTERVAL_MS = 60_000; // check every 60s
  cloudMonitorTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      const { getCloudDevice } = await import("./cloud.service.ts");
      const device = getCloudDevice();
      const { isConnected } = await import("./cloud-ws.service.ts");

      if (device && !cloudConnected) {
        // Device linked but WS not connected — connect now
        log("INFO", "Cloud monitor: device linked detected, connecting to cloud");
        await connectCloud(opts, serverArgs, logFd);
      } else if (device && cloudConnected && !isConnected()) {
        // Device linked, we attempted connection but WS is dead — reconnect
        log("WARN", "Cloud monitor: WS disconnected, reconnecting");
        const { disconnect } = await import("./cloud-ws.service.ts");
        disconnect();
        cloudConnected = false;
        await connectCloud(opts, serverArgs, logFd);
      } else if (!device && cloudConnected) {
        // Device unlinked — disconnect
        log("INFO", "Cloud monitor: device unlinked, disconnecting from cloud");
        const { disconnect } = await import("./cloud-ws.service.ts");
        disconnect();
        cloudConnected = false;
      }
    } catch (e) {
      log("WARN", `Cloud monitor error: ${e}`);
    }
  }, CLOUD_MONITOR_INTERVAL_MS);
}

// ─── Soft stop (server only, supervisor stays alive) ──────────────────
let _softStopRunning = false;
export async function softStop() {
  if (getState() === "stopped" || _softStopRunning) return;
  _softStopRunning = true;

  log("INFO", "Soft stop: killing server, supervisor stays alive");
  notifyStateChange(getState(), "stopped", "user_stop");
  setState("stopped");

  if (serverChild) {
    await requestServerShutdown(serverChild, 1000);
    serverChild = null;
  }

  // Stop health checks (no server to check)
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }

  // Keep: tunnel, Cloud WS, upgrade checks, tunnel probe
  updateStatus({ state: "stopped", pid: null, stoppedAt: new Date().toISOString() });
  // Loopback + OS-assigned: it publishes itself to `.server-port` and the edge
  // routes the public port to it, so the tunnel URL keeps serving.
  startStoppedPage(0, "127.0.0.1");

  // Wait for resume signal
  await waitForResume();

  // Resumed — restart server
  stopStoppedPage();
  await Bun.sleep(200); // brief wait for port release
  notifyStateChange("stopped", "running", "user_start");
  setState("running");
  updateStatus({ state: "running", stoppedAt: null });
  startServerHealthCheck();
  log("INFO", "Resuming server from stopped state");
  _softStopRunning = false;
  spawnServer(_serverArgs, _logFd);
}

// ─── Shutdown ──────────────────────────────────────────────────────────
export function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("INFO", "Supervisor shutting down");

  // Unblock if paused
  triggerResume();

  // Disconnect Cloud WS
  import("./cloud-ws.service.ts")
    .then(({ disconnect }) => disconnect())
    .catch(() => {});

  if (healthTimer) clearInterval(healthTimer);
  if (tunnelProbeTimer) clearInterval(tunnelProbeTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (upgradeCheckTimer) clearInterval(upgradeCheckTimer);
  if (upgradeDelayTimer) clearTimeout(upgradeDelayTimer);
  if (cloudMonitorTimer) clearInterval(cloudMonitorTimer);
  if (descendantSnapshotTimer) clearInterval(descendantSnapshotTimer);

  if (serverChild) {
    log("INFO", `Killing server child (PID: ${serverChild.pid})`);
    const pid = serverChild.pid;
    if (process.platform === "win32") {
      killProcessTree(pid);
    } else {
      try { serverChild.kill("SIGTERM"); } catch {}
      setTimeout(() => { killProcessTree(pid); }, 2000).unref();
    }
  }
  if (tunnelChild) {
    log("INFO", `Killing tunnel child (PID: ${tunnelChild.pid})`);
    try { tunnelChild.kill("SIGKILL"); } catch {}
  }
  if (adoptedTunnelPid) {
    log("INFO", `Killing adopted tunnel (PID: ${adoptedTunnelPid})`);
    try { process.kill(adoptedTunnelPid, "SIGKILL"); } catch {}
  }
  // Same treatment as the tunnel: the edge is detached, so a plain supervisor
  // exit would leave it holding the public port. The self-replace upgrade path
  // exits without calling shutdown(), which is exactly why the edge survives
  // an upgrade but not a stop.
  if (edgePid) {
    log("INFO", `Killing edge forwarder (PID: ${edgePid})`);
    try { process.kill(edgePid, "SIGKILL"); } catch {}
    edgePid = null;
  }
}

// ─── Main entry ────────────────────────────────────────────────────────
export async function runSupervisor(opts: {
  port: number;
  host: string;
  profile?: string;
  share: boolean;
}) {
  const ppmDir = getPpmDir();
  if (!existsSync(ppmDir)) mkdirSync(ppmDir, { recursive: true });

  // Clean up flags from previous upgrade/restart
  try { unlinkSync(restartingFlag()); } catch {}
  try { unlinkSync(serverShutdownFile()); } catch {}

  // A Windows binary upgrade can't delete the running .exe, so it renames the
  // old one aside; this fresh process (old one now gone) removes the leftover.
  if (isCompiledBinary()) {
    cleanupStaleBinaryUpgradeArtifacts(resolve(process.execPath, ".."), process.platform);
  }

  // Save original argv for self-replace
  originalArgv = [...process.argv];

  const logFd = openSync(logFile(), "a");
  log("INFO", `Supervisor started (PID: ${process.pid}, port: ${opts.port}, share: ${opts.share})`);

  // ── Systemd self-heal: if the unit file is stale (e.g. still has
  // Restart=on-failure), we were likely spawned by the old Bun.spawn()
  // upgrade path and systemd can't track us ("not our child").  Restart=always
  // won't trigger on exit because systemd never notices we exited.
  // Fix: regenerate the unit, then restart *through* systemd so it spawns a
  // properly-tracked child.  The restart runs in a separate systemd-run scope
  // so it survives our cgroup teardown.
  const underSystemd = !!process.env.INVOCATION_ID && process.platform === "linux";
  if (underSystemd) {
    try {
      const { isAutoStartUnitStale, enableAutoStart } = await import("./autostart-register.ts");
      if (isAutoStartUnitStale()) {
        log("INFO", "Stale systemd unit detected — regenerating and restarting through systemd for proper process tracking");
        await enableAutoStart(
          { port: opts.port, host: opts.host, share: opts.share, profile: opts.profile },
          { skipStart: true },
        );
        // Schedule restart in a separate scope (survives our cgroup teardown)
        Bun.spawn({
          cmd: ["systemd-run", "--user", "--scope", "--quiet", "--collect",
                "--", "systemctl", "--user", "restart", "ppm.service"],
          stdio: ["ignore", "ignore", "ignore"],
        }).unref();
        // Give systemd-run a moment to register the scope, then exit
        await Bun.sleep(1000);
        process.exit(0);
      }
    } catch (e) {
      log("WARN", `Systemd self-heal failed (non-fatal): ${e}`);
    }
  }

  // Global exception handlers — supervisor must never crash
  process.on("uncaughtException", (err) => {
    log("ERROR", `Uncaught exception: ${err.stack || err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    log("ERROR", `Unhandled rejection: ${reason}`);
  });

  // Full write to clear stale data — but preserve tunnel info during self-replace upgrade
  // so the new supervisor can adopt the existing tunnel and keep the domain.
  writeFileSync(PID_FILE(), String(process.pid));
  const prevStatus = readStatus();
  const isUpgrade = prevStatus.state === "upgrading";
  writeStatus({
    supervisorPid: process.pid, port: opts.port, host: opts.host, availableVersion: null,
    state: "running", pausedAt: null, pauseReason: null, lastCrashError: null,
    pid: null,
    tunnelPid: isUpgrade ? (prevStatus.tunnelPid ?? null) : null,
    shareUrl: isUpgrade ? (prevStatus.shareUrl ?? null) : null,
    tunnelPort: isUpgrade ? (prevStatus.tunnelPort ?? null) : null,
    // The edge is detached and survives self-replace exactly like the tunnel,
    // so its PID must survive this wholesale rewrite or the new supervisor
    // would spawn a second edge and collide on the public port.
    edgePid: isUpgrade ? (prevStatus.edgePid ?? null) : null,
    // tunnelMode/tunnelWarning survive an upgrade the same way tunnelPid/shareUrl
    // do above — otherwise a live named tunnel would report as unset mode with
    // no warning history the instant the new supervisor takes over.
    tunnelMode: isUpgrade ? (prevStatus.tunnelMode ?? null) : null,
    tunnelWarning: isUpgrade ? (prevStatus.tunnelWarning ?? null) : null,
    // Unconditional (not upgrade-gated): every boot of this code understands
    // "retunnel" — its ABSENCE is how phase 3's UI detects a pre-upgrade
    // supervisor that predates the retunnel command entirely.
    capabilities: ["retunnel"],
    serverPort: null, // republished by the server on every spawn
  });
  // Diagnostic: a cold start (isUpgrade=false) always nulls the tunnel and forces
  // a fresh URL. A genuine upgrade must arrive here with state "upgrading" AND a
  // live tunnelPid for the public URL to survive — log both to catch which path ran.
  log("INFO", `Startup: isUpgrade=${isUpgrade} prevState=${prevStatus.state} prevTunnelPid=${prevStatus.tunnelPid ?? null} prevShareUrl=${prevStatus.shareUrl ?? null}`);

  // Build __serve__ args. Port 0 = OS-assigned, bound to loopback only: the
  // edge is the sole public listener, and the server publishes whatever port it
  // got to `.server-port`.
  const serverArgs = [
    "__serve__", "0", "127.0.0.1",
    opts.profile ?? "",
  ];
  // Strip trailing empty args
  while (serverArgs.length > 0 && serverArgs[serverArgs.length - 1] === "") serverArgs.pop();

  // Save module-level refs for softStop()
  _serverArgs = serverArgs;
  _logFd = logFd;
  _opts = { port: opts.port, host: opts.host, share: opts.share };

  // Signal handlers — force exit after 5s if process.exit doesn't work
  const forceShutdown = (signal: string) => {
    log("INFO", `${signal} received`);
    shutdown();
    // Safety net: force kill self if process.exit(0) doesn't terminate
    setTimeout(() => {
      log("WARN", `Force exit after ${signal} — process.exit(0) did not terminate`);
      try { process.kill(process.pid, "SIGKILL"); } catch {}
    }, 5000).unref();
    process.exit(0);
  };
  process.on("SIGTERM", () => forceShutdown("SIGTERM"));
  process.on("SIGINT", () => forceShutdown("SIGINT"));

  // SIGUSR2 = command file dispatch OR graceful server restart
  process.on("SIGUSR2", async () => {
    // Check for command file first (soft_stop, resume, retunnel)
    const cmd = readAndDeleteCmd();
    if (cmd) {
      if (cmd.action === "soft_stop") {
        log("INFO", "SIGUSR2: soft_stop command received");
        softStop();
        return;
      }
      if (cmd.action === "resume") {
        log("INFO", "SIGUSR2: resume command received");
        if (getState() === "stopped" || getState() === "paused") {
          triggerResume();
        }
        return;
      }
      if (cmd.action === "retunnel") {
        log("INFO", "SIGUSR2: retunnel command received");
        namedTunnelMode = await readTunnelConfigFresh();
        // A deliberate corrective action (e.g. the user just fixed DNS) gets a
        // fresh one-restart budget rather than inheriting a stale exhausted one.
        namedProbeRestartAttempted = false;
        restartTunnel(_opts.port);
        // Deliberate fall-through (no return): a bare `ppm restart` sends a
        // bare SIGUSR2 with no command file of its own, and a `retunnel` that
        // happens to still be unclaimed at that instant must not silently
        // swallow the user's restart intent. Retunneling first costs nothing
        // extra — it's a fast no-op when the tunnel is already correct — and
        // this still restarts the server exactly like a plain SIGUSR2 would.
      }
    }

    // Default: restart server (existing behavior, and retunnel's fall-through target)
    if (getState() === "paused") {
      log("INFO", "SIGUSR2 received while paused, resuming server");
      triggerResume();
      return;
    }
    if (getState() === "stopped") {
      log("INFO", "SIGUSR2 received while stopped, resuming server");
      triggerResume();
      return;
    }
    log("INFO", "SIGUSR2 received, restarting server only");
    if (serverChild) {
      serverRestartRequested = true; // flag so spawnServer skips backoff
      requestServerShutdown(serverChild).catch(() => {});
    } else {
      // Nothing to bounce — the spawn loop is gone. Without this `ppm restart`
      // silently no-ops and only `stop --kill` + `start` recovers.
      log("WARN", "No server child to restart — spawning one");
      noServerChildCycles = 0;
      spawnServer(serverArgs, logFd).catch((e) => log("ERROR", `Server respawn failed: ${e}`));
    }
  });

  // SIGUSR1 = self-replace for upgrade
  process.on("SIGUSR1", async () => {
    log("INFO", "SIGUSR1 received, starting self-replace for upgrade");
    const result = await selfReplace();
    if (!result.success) {
      log("ERROR", `Self-replace failed: ${result.error}, restarting children`);
      spawnServer(serverArgs, logFd);
      // Tunnel was kept alive during selfReplace; only respawn if dead
      if (opts.share && !tunnelChild && !tunnelUrl) spawnTunnel(_opts.port);
    }
  });

  // Windows: track the server's descendants so stop/upgrade/restart can reap
  // orphans that escape taskkill /T (spawnServer reaps before every bind).
  if (process.platform === "win32") {
    descendantSnapshotTimer = setInterval(() => {
      const pid = serverChild?.pid;
      if (pid && !shuttingDown) snapshotServerDescendants(pid).catch(() => {});
    }, 30_000);
  }

  // Start health checks
  startServerHealthCheck();

  // ── Resume-from-sleep detection ────────────────────────────────────────
  // A setInterval that fires much later than its period means the host was
  // suspended (hibernate/sleep). On resume the cloudflared QUIC link is usually
  // dead — its trycloudflare hostname is withdrawn (ERR_NAME_NOT_RESOLVED) — and
  // an orphaned socket may block the port, triggering a crash cascade that
  // exhausts the restart budget and pauses the server. Detect the wall-clock
  // gap, reset the budgets, unpause, and regenerate the tunnel so we self-heal
  // to a working URL instead of staying dark.
  const RESUME_TICK_MS = 30_000;
  const RESUME_GAP_MS = 90_000; // fired >3× late ⇒ treat as resume-from-sleep
  let lastResumeTick = Date.now();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const gap = now - lastResumeTick;
    lastResumeTick = now;
    if (gap < RESUME_GAP_MS || shuttingDown) return;
    log("WARN", `Wall-clock gap ${Math.round(gap / 1000)}s — likely resume from sleep; resetting restart budgets + regenerating tunnel`);
    serverRestarts = 0;
    tunnelRestarts = 0;
    healthFailCount = 0;
    tunnelFailCount = 0;
    // If paused solely from the post-resume failure cascade, resume the server.
    if (getState() === "paused") triggerResume();
    // The old quick-tunnel session MAY be dead after resume, but cloudflared
    // self-heals transient QUIC drops on its own. Only force a fresh tunnel if
    // we haven't just rotated — otherwise a laptop that sleeps/wakes constantly
    // regenerates hundreds of quick tunnels/day, tripping trycloudflare's
    // per-IP rate limit so NO tunnel can register. The tunnel probe still
    // regenerates a genuinely-zombied URL (edge dropped) within ~5min.
    if (getState() === "running" && (tunnelUrl || tunnelChild || adoptedTunnelPid)) {
      const sinceRegen = now - lastTunnelRegenAt;
      if (sinceRegen >= TUNNEL_REGEN_MIN_INTERVAL_MS) {
        restartTunnel(_opts.port);
      } else {
        log("INFO", `Resume: tunnel regen skipped (last regen ${Math.round(sinceRegen / 1000)}s ago); probe will heal if truly dead`);
      }
    }
  }, RESUME_TICK_MS);

  // Start upgrade check timer (5min initial delay, then every 15min)
  upgradeDelayTimer = setTimeout(() => {
    checkAvailableVersion();
    upgradeCheckTimer = setInterval(checkAvailableVersion, UPGRADE_CHECK_INTERVAL_MS);
  }, UPGRADE_SKIP_INITIAL_MS);

  // Windows: poll command file since SIGUSR2 is not available
  if (process.platform === "win32") {
    setInterval(() => {
      const cmd = readAndDeleteCmd();
      if (!cmd) return;
      if (cmd.action === "soft_stop") { softStop(); }
      else if (cmd.action === "resume") {
        if (getState() === "stopped" || getState() === "paused") triggerResume();
      }
      else if (cmd.action === "restart") {
        log("INFO", "Windows command: restart server only");
        if (getState() === "paused" || getState() === "stopped") {
          triggerResume();
        } else if (serverChild) {
          serverRestartRequested = true;
          // Tree-kill + reap — single-PID kill orphans SDK grandchildren that
          // hold the inherited listening-socket handle (zombie port → the
          // respawned server can't bind and `ppm restart` times out).
          requestServerShutdown(serverChild).catch(() => {});
        }
      }
      else if (cmd.action === "retunnel") {
        log("INFO", "Windows command: retunnel");
        // No POSIX-style fall-through ambiguity here — every command on this
        // poll loop is an explicit file, one command per tick, already claimed
        // atomically by readAndDeleteCmd. Just retunnel; don't also trigger
        // the unrelated "restart" branch.
        readTunnelConfigFresh().then((cfg) => {
          namedTunnelMode = cfg;
          // A deliberate corrective action gets a fresh one-restart budget
          // rather than inheriting a stale exhausted one.
          namedProbeRestartAttempted = false;
          restartTunnel(_opts.port);
        });
      }
      else if (cmd.action === "upgrade") {
        log("INFO", "Windows command: upgrade, starting self-replace");
        selfReplace().then((result) => {
          if (!result.success) {
            log("ERROR", `Self-replace failed: ${result.error}, restarting children`);
            spawnServer(serverArgs, logFd);
            if (opts.share && !tunnelChild && !tunnelUrl) spawnTunnel(_opts.port);
          }
        });
      }
    }, 1000);
  }

  // Connect to Cloud via WebSocket (if device is linked) + start monitoring
  connectCloud(opts, serverArgs, logFd);
  startCloudMonitor(opts, serverArgs, logFd);

  // Signal readiness to systemd (Type=notify). No-op on non-systemd platforms.
  // Must happen AFTER signal handlers + status.json are set up so systemd
  // can race-freely promote us to MainPID and forward SIGUSR1/TERM.
  await sdNotify("READY=1");

  // Adopt tunnel BEFORE spawning the server: spawnServer prefers the adopted
  // tunnel's origin port (public URL continuity), so adoption state must be
  // settled first — the old order raced spawnServer's port selection.
  let tunnelAdopted = false;
  if (opts.share) {
    // Populate the cache BEFORE adoptTunnel/probe — an adopted tunnel skips
    // spawnTunnel entirely for this whole generation, so without this the
    // cache would stay null (adoptTunnel's named-hostname gate always refuses,
    // and the probe can never tell named from quick) until the next spawn.
    namedTunnelMode = await readTunnelConfigFresh();
    // Defensive — already `false` at module init, but a fresh boot must never
    // start with an inherited restart-once budget "spent".
    namedProbeRestartAttempted = false;
    startTunnelProbe();
    // Try adopting tunnel kept alive from previous upgrade; spawn new if dead
    tunnelAdopted = adoptTunnel();
    if (tunnelAdopted) {
      log("INFO", "Tunnel adopted from previous instance — public URL preserved");
    } else {
      log("WARN", "Tunnel adoption failed/skipped — spawning FRESH tunnel (public URL will change)");
      killStaleTunnel(); // kill orphaned tunnel before spawning new one
    }
    // Sweep leftover cloudflared orphans (crashed supervisors / pre-fix stale
    // loops) so they don't saturate the network and false-trigger regeneration.
    await reapOrphanedTunnels(tunnelAdopted ? adoptedTunnelPid : null);
  }

  // The edge owns the public port, so it must exist before anything else tries
  // to use that port — and it must be started BEFORE the server child. The
  // edge's listening socket lives in the edge process, so a server spawned
  // afterwards cannot inherit it; reversing this order would put the socket in
  // reach of the server's chat/tool/MCP descendants and reintroduce the very
  // zombie-port failure the edge exists to prevent.
  //
  // Prefer the port the adopted tunnel already points at: binding anywhere else
  // would strand cloudflared on a dead origin and force a URL rotation.
  const publicPort = tunnelAdopted && tunnelPort !== null ? tunnelPort : opts.port;
  if (publicPort !== opts.port) {
    log("INFO", `Edge takes tunnel origin port ${publicPort} over configured ${opts.port} (public URL continuity)`);
  }

  // Adoption MUST be attempted before any bind probe. `ensureBindablePort`
  // treats a PPM process holding the port as debris to reclaim and tree-kills
  // it — which, for a healthy adopted edge, would destroy the one thing keeping
  // the public URL alive across the upgrade. Probe only when there is no edge.
  let boundPublicPort = publicPort;
  if (!(await adoptEdge(publicPort, opts.host))) {
    boundPublicPort = await ensureBindablePort(publicPort, opts.host);
    if (boundPublicPort !== publicPort) {
      log("WARN", `Public port ${publicPort} unbindable — edge moved to ${boundPublicPort}. This is now the ONLY thing that can rotate the public URL.`);
    }
    await spawnEdge(boundPublicPort, opts.host, logFd);
  }
  _opts.port = boundPublicPort;
  updateStatus({ port: boundPublicPort });
  startEdgeProbe(boundPublicPort, opts.host, logFd);

  // Sanity check, not a port-move trigger: if the edge could not take the port
  // the adopted tunnel points at, that tunnel is now aimed at a dead origin and
  // would serve nothing. Drop it so the fresh-tunnel path below replaces it.
  // Unreachable in normal operation — reaching it means a zombie held the
  // public port, which is the one remaining way the public URL can rotate.
  if (tunnelAdopted && tunnelPort !== null && tunnelPort !== boundPublicPort) {
    log("WARN", `Adopted tunnel targets origin ${tunnelPort} but the edge bound ${boundPublicPort} — the public URL cannot be preserved, replacing the tunnel`);
    if (adoptedTunnelPid) { try { process.kill(adoptedTunnelPid, "SIGTERM"); } catch {} adoptedTunnelPid = null; }
    tunnelUrl = null;
    tunnelPort = null;
    updateStatus({ shareUrl: null, tunnelPid: null, tunnelPort: null });
    tunnelAdopted = false;
  }

  // Spawn server + (fresh) tunnel in parallel
  const promises: Promise<void>[] = [spawnServer(serverArgs, logFd)];
  if (opts.share && !tunnelAdopted) promises.push(spawnTunnel(_opts.port));

  await Promise.all(promises);

  // If upgrading, selfReplace handles process.exit — wait for it
  if (getState() === "upgrading") {
    log("INFO", "Server loop exited during upgrade, waiting for selfReplace to finish");
    await new Promise(() => {}); // selfReplace will call process.exit()
  }

  // If we get here, both loops exited (shutdown or max restarts)
  log("INFO", "Supervisor exiting");
  process.exit(shuttingDown ? 0 : 1);
}

// ─── CLI entry point ───────────────────────────────────────────────────
if (process.argv.includes("__supervise__")) {
  const idx = process.argv.indexOf("__supervise__");
  const port = parseInt(process.argv[idx + 1] ?? "8080", 10);
  const host = process.argv[idx + 2] ?? "0.0.0.0";
  const profileRaw = process.argv[idx + 3];
  const profile = profileRaw && profileRaw !== "_" && !profileRaw.startsWith("--") ? profileRaw : undefined;
  // Tunnel always enabled — cloudflared shares the server publicly. `--share` is a deprecated no-op
  // (see src/server/index.ts:227, src/index.ts:27). Supervisor must not gate on it.
  const share = true;

  // Set DB profile for supervisor (needed to read config)
  if (profile) {
    const { setDbProfile } = await import("./db.service.ts");
    setDbProfile(profile);
  }

  runSupervisor({ port, host, profile, share });
}
