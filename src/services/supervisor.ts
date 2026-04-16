/**
 * Supervisor process — long-lived parent that manages server child + tunnel child.
 * Respawns children on crash with exponential backoff.
 * Health-checks server (/api/health) and tunnel URL (public probe).
 * Entry: __supervise__ <port> <host> [config] [profile] [--share]
 */
import type { Subprocess } from "bun";
import { resolve } from "node:path";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, openSync, appendFileSync,
  unlinkSync,
} from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";
import { isCompiledBinary } from "./autostart-generator.ts";
import {
  type SupervisorState,
  getState, setState, waitForResume, triggerResume,
  readAndDeleteCmd, readStatus, updateStatus, writeStatus,
  STATUS_FILE, PID_FILE,
} from "./supervisor-state.ts";
import { startStoppedPage, stopStoppedPage } from "./supervisor-stopped-page.ts";

// ─── Constants ─────────────────────────────────────────────────────────
const MAX_RESTARTS = 10;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_WINDOW_MS = 300_000;       // 5min stable → reset restart counter
const SERVER_HEALTH_INTERVAL_MS = 30_000;
const SERVER_HEALTH_FAIL_THRESHOLD = 3;
const TUNNEL_PROBE_INTERVAL_MS = 30_000;    // 30s — adopted tunnels have no `exited` promise
const TUNNEL_PROBE_FAIL_THRESHOLD = 3;      // 3 HTTP failures before regenerating (PID check is instant)
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const UPGRADE_CHECK_INTERVAL_MS = 900_000;  // 15min
const UPGRADE_SKIP_INITIAL_MS = 300_000;    // 5min delay before first check
const SELF_REPLACE_TIMEOUT_MS = 30_000;     // 30s to wait for new supervisor

const logFile = () => resolve(getPpmDir(), "ppm.log");
const restartingFlag = () => resolve(getPpmDir(), ".restarting");

// ─── State ─────────────────────────────────────────────────────────────
let serverChild: Subprocess | null = null;
let tunnelChild: Subprocess | null = null;
let tunnelUrl: string | null = null;
let adoptedTunnelPid: number | null = null; // PID of tunnel kept alive across upgrade
let shuttingDown = false;

// Module-level refs for softStop (needs access to respawn args)
let _serverArgs: string[] = [];
let _logFd: number = -1;
let _opts: { port: number; host: string; share: boolean } = { port: 8080, host: "0.0.0.0", share: false };

let serverRestarts = 0;
let lastServerCrash = 0;
let tunnelRestarts = 0;
let lastTunnelCrash = 0;

let healthFailCount = 0;
let tunnelFailCount = 0;
let serverRestartRequested = false; // SIGUSR2 flag — skip backoff on next crash

// Timers for cleanup
let healthTimer: ReturnType<typeof setInterval> | null = null;
let tunnelProbeTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let upgradeCheckTimer: ReturnType<typeof setInterval> | null = null;
let upgradeDelayTimer: ReturnType<typeof setTimeout> | null = null;
let cloudMonitorTimer: ReturnType<typeof setInterval> | null = null;
let cloudConnected = false; // tracks whether we've initiated a cloud WS connection

// Saved at startup for self-replace
let originalArgv: string[] = [];

// ─── Logging ───────────────────────────────────────────────────────────
function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [supervisor] ${msg}\n`;
  try { appendFileSync(logFile(), line); } catch {}
  if (level === "ERROR" || level === "FATAL") {
    process.stderr.write(line);
  }
}

// ─── Backoff calc ──────────────────────────────────────────────────────
function backoffDelay(restartCount: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (restartCount - 1), BACKOFF_MAX_MS);
}

// ─── Server management ─────────────────────────────────────────────────
export async function spawnServer(
  serverArgs: string[],
  logFd: number,
): Promise<void> {
  const cmd = isCompiledBinary()
    ? [process.execPath, ...serverArgs]
    : [process.execPath, "run", resolve(import.meta.dir, "..", "server", "index.ts"), ...serverArgs];

  serverChild = Bun.spawn({
    cmd,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  const childPid = serverChild.pid;
  updateStatus({ pid: childPid });
  writeFileSync(PID_FILE(), String(process.pid)); // supervisor PID for stop
  log("INFO", `Server started (PID: ${childPid})`);

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
async function extractUrlFromStderr(stderr: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Tunnel URL timeout (30s)")), 30_000);

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const match = buffer.match(TUNNEL_URL_REGEX);
          if (match) {
            clearTimeout(timeout);
            // Keep draining in background to avoid SIGPIPE
            (async () => {
              try { while (!(await reader.read()).done) {} } catch {}
            })();
            resolve(match[0]);
            return;
          }
        }
        clearTimeout(timeout);
        reject(new Error("cloudflared exited without providing URL"));
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    };
    read();
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

export async function spawnTunnel(port: number): Promise<void> {
  let bin: string;
  try {
    const { ensureCloudflared } = await import("./cloudflared.service.ts");
    bin = await ensureCloudflared();
  } catch (err) {
    log("ERROR", `Failed to get cloudflared: ${err}`);
    return;
  }

  tunnelChild = Bun.spawn(
    [bin, "tunnel", "--url", `http://127.0.0.1:${port}`],
    { stderr: "pipe", stdout: "ignore", stdin: "ignore" },
  );

  try {
    tunnelUrl = await extractUrlFromStderr(tunnelChild.stderr as ReadableStream<Uint8Array>);
  } catch (err) {
    log("ERROR", `Tunnel URL extraction failed: ${err}`);
    tunnelUrl = null;
    try { tunnelChild.kill(); } catch {}
    tunnelChild = null;

    if (shuttingDown) return;
    tunnelRestarts++;
    const delay = backoffDelay(tunnelRestarts);
    log("WARN", `Tunnel failed, retry in ${delay}ms (#${tunnelRestarts})`);
    await Bun.sleep(delay);
    return spawnTunnel(port);
  }

  updateStatus({ shareUrl: tunnelUrl, tunnelPid: tunnelChild.pid });
  log("INFO", `Tunnel ready: ${tunnelUrl} (PID: ${tunnelChild.pid})`);

  // One-time sync of tunnel URL to cloud (WS handles periodic heartbeat)
  await syncUrlToCloud(tunnelUrl);

  const exitCode = await tunnelChild.exited;
  tunnelChild = null;
  const deadUrl = tunnelUrl;
  tunnelUrl = null;

  if (shuttingDown) return;

  // Crash — apply backoff
  const now = Date.now();
  if (now - lastTunnelCrash > STABLE_WINDOW_MS) tunnelRestarts = 0;
  lastTunnelCrash = now;
  tunnelRestarts++;

  if (tunnelRestarts > MAX_RESTARTS) {
    log("ERROR", `Tunnel exceeded ${MAX_RESTARTS} restarts, disabling tunnel`);
    updateStatus({ shareUrl: null, tunnelPid: null });
    return;
  }

  const delay = backoffDelay(tunnelRestarts);
  log("WARN", `Tunnel died (exit ${exitCode}, was ${deadUrl}), restart in ${delay}ms (#${tunnelRestarts})`);
  await Bun.sleep(delay);

  if (!shuttingDown) return spawnTunnel(port);
}

// ─── Health checks ─────────────────────────────────────────────────────
function startServerHealthCheck(port: number) {
  healthTimer = setInterval(async () => {
    if (shuttingDown || !serverChild || getState() === "stopped") return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) { healthFailCount = 0; return; }
    } catch {}
    healthFailCount++;
    if (healthFailCount >= SERVER_HEALTH_FAIL_THRESHOLD && serverChild) {
      log("WARN", `Server unresponsive (${healthFailCount} failures), killing`);
      try { serverChild.kill(); } catch {}
      healthFailCount = 0;
      // spawnServer loop handles respawn via exited promise
    }
  }, SERVER_HEALTH_INTERVAL_MS);
}

function startTunnelProbe(port: number) {
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
        updateStatus({ shareUrl: null, tunnelPid: null });
        tunnelFailCount = 0;
        spawnTunnel(port);
        return;
      }
    }

    try {
      const res = await fetch(`${tunnelUrl}/api/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        tunnelFailCount = 0;
        tunnelRestarts = 0;
        return;
      }
    } catch {}
    tunnelFailCount++;
    if (tunnelFailCount >= TUNNEL_PROBE_FAIL_THRESHOLD) {
      log("WARN", `Tunnel URL dead (${tunnelFailCount} failures), regenerating`);
      if (tunnelChild) {
        try { tunnelChild.kill(); } catch {}
        // spawnTunnel loop handles respawn via exited promise
      } else if (adoptedTunnelPid) {
        try { process.kill(adoptedTunnelPid, "SIGTERM"); } catch {}
        adoptedTunnelPid = null;
        tunnelUrl = null;
        updateStatus({ shareUrl: null, tunnelPid: null });
        spawnTunnel(port);
      }
      tunnelFailCount = 0;
    }
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
    adoptedTunnelPid = pid;
    tunnelUrl = url;
    log("INFO", `Adopted existing tunnel (PID: ${pid}, URL: ${url})`);
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

/** Spawn new supervisor from updated code, wait for it to be healthy, then exit */
async function selfReplace(): Promise<{ success: boolean; error?: string }> {
  log("INFO", "Starting self-replace for upgrade");
  const currentSupervisorPid = process.pid;

  try {
    // Prevent spawnServer crash-restart loop from respawning killed children
    shuttingDown = true;
    notifyStateChange(getState(), "upgrading", "self_replace");
    setState("upgrading");
    updateStatus({ state: "upgrading" });

    // Set restarting flag so server child's stopTunnel() skips killing the tunnel
    try { writeFileSync(restartingFlag(), ""); } catch {}

    // Clear probe timer FIRST to prevent race between flush check and queued callback
    if (tunnelProbeTimer) { clearInterval(tunnelProbeTimer); tunnelProbeTimer = null; }

    // Final tunnel liveness check before handing off to new supervisor —
    // if the adopted tunnel died since the last probe, clear status so the
    // new supervisor spawns fresh instead of discovering ESRCH.
    if (adoptedTunnelPid && !tunnelChild) {
      try { process.kill(adoptedTunnelPid, 0); } catch {
        log("WARN", "Pre-upgrade: adopted tunnel dead, clearing for new supervisor to spawn fresh");
        adoptedTunnelPid = null;
        tunnelUrl = null;
        updateStatus({ shareUrl: null, tunnelPid: null });
      }
    }

    // Kill server child to free the port; keep tunnel alive for domain continuity
    log("INFO", "Stopping server before spawning new supervisor (tunnel kept alive)");
    if (serverChild) { try { serverChild.kill(); } catch {} serverChild = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    // Brief wait for port release
    await Bun.sleep(500);

    // Spawn new supervisor using saved argv
    const cmd = originalArgv.slice();
    const logFd = openSync(logFile(), "a");
    const child = Bun.spawn({
      cmd,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();

    // Poll status.json for new supervisor PID (up to 30s)
    const start = Date.now();
    while (Date.now() - start < SELF_REPLACE_TIMEOUT_MS) {
      await Bun.sleep(1000);
      try {
        const data = JSON.parse(readFileSync(STATUS_FILE(), "utf-8"));
        if (data.supervisorPid && data.supervisorPid !== currentSupervisorPid) {
          log("INFO", `New supervisor detected (PID: ${data.supervisorPid}), old exiting`);
          // Children already killed, just clear remaining timers and exit
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          if (upgradeCheckTimer) clearInterval(upgradeCheckTimer);
          if (upgradeDelayTimer) clearTimeout(upgradeDelayTimer);
          process.exit(0);
        }
      } catch {}
    }

    // Timeout — new supervisor didn't start, restore old supervisor
    log("ERROR", "Self-replace timeout: new supervisor did not start");
    try { child.kill(); } catch {}
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
    const { configService } = await import("./config.service.ts");
    const device = getCloudDevice();
    if (!device) return false; // not linked to cloud

    const { connect, onCommand } = await import("./cloud-ws.service.ts");
    const { VERSION } = await import("../version.ts");
    const startTime = Date.now();

    connect({
      cloudUrl: device.cloud_url,
      deviceId: device.device_id,
      secretKey: device.secret_key,
      heartbeatFn: () => {
        const status = readStatus();
        // Re-read device file each heartbeat to pick up name changes
        const currentDevice = getCloudDevice();
        // Sync device name from config if user changed it in settings
        const configName = configService.get("device_name") as string;
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
            try { serverChild.kill(); } catch {}
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

  // Kill server child
  if (serverChild) {
    try { serverChild.kill(); } catch {}
    serverChild = null;
  }

  // Stop health checks (no server to check)
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }

  // Keep: tunnel, Cloud WS, upgrade checks, tunnel probe
  updateStatus({ state: "stopped", pid: null, stoppedAt: new Date().toISOString() });

  // Start stopped page on the server port so tunnel URL still works
  await Bun.sleep(500); // brief wait for port release
  startStoppedPage(_opts.port, _opts.host);

  // Wait for resume signal
  await waitForResume();

  // Resumed — restart server
  stopStoppedPage();
  await Bun.sleep(200); // brief wait for port release
  notifyStateChange("stopped", "running", "user_start");
  setState("running");
  updateStatus({ state: "running", stoppedAt: null });
  startServerHealthCheck(_opts.port);
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

  if (serverChild) { try { serverChild.kill(); } catch {} }
  if (tunnelChild) { try { tunnelChild.kill(); } catch {} }
  if (adoptedTunnelPid) { try { process.kill(adoptedTunnelPid, "SIGTERM"); } catch {} }
}

// ─── Main entry ────────────────────────────────────────────────────────
export async function runSupervisor(opts: {
  port: number;
  host: string;
  config?: string;
  profile?: string;
  share: boolean;
}) {
  const ppmDir = getPpmDir();
  if (!existsSync(ppmDir)) mkdirSync(ppmDir, { recursive: true });

  // Clean up restarting flag from previous upgrade/restart
  try { unlinkSync(restartingFlag()); } catch {}

  // Save original argv for self-replace
  originalArgv = [...process.argv];

  const logFd = openSync(logFile(), "a");
  log("INFO", `Supervisor started (PID: ${process.pid}, port: ${opts.port}, share: ${opts.share})`);

  // Global exception handlers — supervisor must never crash
  process.on("uncaughtException", (err) => {
    log("ERROR", `Uncaught exception: ${err.stack || err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    log("ERROR", `Unhandled rejection: ${reason}`);
  });

  // Full write to clear any stale data from previous runs (different port, dead PIDs, etc.)
  writeFileSync(PID_FILE(), String(process.pid));
  writeStatus({
    supervisorPid: process.pid, port: opts.port, host: opts.host, availableVersion: null,
    state: "running", pausedAt: null, pauseReason: null, lastCrashError: null,
    pid: null, tunnelPid: null, shareUrl: null,
  });

  // Build __serve__ args
  const serverArgs = [
    "__serve__", String(opts.port), opts.host,
    opts.config ?? "", opts.profile ?? "",
  ];
  // Strip trailing empty args
  while (serverArgs.length > 0 && serverArgs[serverArgs.length - 1] === "") serverArgs.pop();

  // Save module-level refs for softStop()
  _serverArgs = serverArgs;
  _logFd = logFd;
  _opts = { port: opts.port, host: opts.host, share: opts.share };

  // Signal handlers
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });
  process.on("SIGINT", () => { shutdown(); process.exit(0); });

  // SIGUSR2 = command file dispatch OR graceful server restart
  process.on("SIGUSR2", () => {
    // Check for command file first (soft_stop, resume)
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
    }

    // Default: restart server (existing behavior)
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
      try { serverChild.kill(); } catch {}
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
      if (opts.share && !tunnelChild && !tunnelUrl) spawnTunnel(opts.port);
    }
  });

  // Start health checks
  startServerHealthCheck(opts.port);

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
    }, 1000);
  }

  // Connect to Cloud via WebSocket (if device is linked) + start monitoring
  connectCloud(opts, serverArgs, logFd);
  startCloudMonitor(opts, serverArgs, logFd);

  // Spawn server + tunnel in parallel
  const promises: Promise<void>[] = [spawnServer(serverArgs, logFd)];

  if (opts.share) {
    startTunnelProbe(opts.port);
    // Try adopting tunnel kept alive from previous upgrade; spawn new if dead
    if (!adoptTunnel()) {
      killStaleTunnel(); // kill orphaned tunnel before spawning new one
      promises.push(spawnTunnel(opts.port));
    }
  }

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
  const config = process.argv[idx + 3] && process.argv[idx + 3] !== "_" ? process.argv[idx + 3] : undefined;
  const profile = process.argv[idx + 4] && process.argv[idx + 4] !== "_" ? process.argv[idx + 4] : undefined;
  const share = process.argv.includes("--share");

  // Set DB profile for supervisor (needed to read config)
  if (profile) {
    const { setDbProfile } = await import("./db.service.ts");
    setDbProfile(profile);
  }

  runSupervisor({ port, host, config, profile, share });
}
