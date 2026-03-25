/**
 * Supervisor process — long-lived parent that manages server child + tunnel child.
 * Respawns children on crash with exponential backoff.
 * Health-checks server (/api/health) and tunnel URL (public probe).
 * Entry: __supervise__ <port> <host> [config] [profile] [--share]
 */
import type { Subprocess } from "bun";
import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, openSync, appendFileSync,
} from "node:fs";
import { isCompiledBinary } from "./autostart-generator.ts";

// ─── Constants ─────────────────────────────────────────────────────────
const MAX_RESTARTS = 10;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_WINDOW_MS = 300_000;       // 5min stable → reset restart counter
const SERVER_HEALTH_INTERVAL_MS = 30_000;
const SERVER_HEALTH_FAIL_THRESHOLD = 3;
const TUNNEL_PROBE_INTERVAL_MS = 120_000;
const TUNNEL_PROBE_FAIL_THRESHOLD = 2;
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const PPM_DIR = resolve(homedir(), ".ppm");
const STATUS_FILE = resolve(PPM_DIR, "status.json");
const PID_FILE = resolve(PPM_DIR, "ppm.pid");
const LOG_FILE = resolve(PPM_DIR, "ppm.log");

// ─── State ─────────────────────────────────────────────────────────────
let serverChild: Subprocess | null = null;
let tunnelChild: Subprocess | null = null;
let tunnelUrl: string | null = null;
let shuttingDown = false;

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

// ─── Logging ───────────────────────────────────────────────────────────
function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [supervisor] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
  if (level === "ERROR" || level === "FATAL") {
    process.stderr.write(line);
  }
}

// ─── Status management ─────────────────────────────────────────────────
function readStatus(): Record<string, unknown> {
  try {
    if (existsSync(STATUS_FILE)) return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch {}
  return {};
}

function updateStatus(patch: Record<string, unknown>) {
  try {
    const data = { ...readStatus(), ...patch };
    writeFileSync(STATUS_FILE, JSON.stringify(data));
  } catch {}
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
  writeFileSync(PID_FILE, String(process.pid)); // supervisor PID for stop
  log("INFO", `Server started (PID: ${childPid})`);

  const exitCode = await serverChild.exited;
  serverChild = null;

  if (exitCode === 0 || shuttingDown) {
    log("INFO", `Server exited cleanly (code ${exitCode})`);
    return;
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
    log("FATAL", `Server exceeded ${MAX_RESTARTS} restarts, giving up`);
    shutdown();
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

function startCloudHeartbeat(url: string) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (tunnelUrl) syncUrlToCloud(tunnelUrl);
  }, 5 * 60 * 1000);
}

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

  // Sync new URL to cloud immediately + start periodic heartbeat
  await syncUrlToCloud(tunnelUrl);
  startCloudHeartbeat(tunnelUrl);

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
    if (shuttingDown || !serverChild) return;
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
    if (shuttingDown || !tunnelUrl || !tunnelChild) {
      tunnelFailCount = 0;
      return;
    }
    try {
      const res = await fetch(`${tunnelUrl}/api/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        tunnelFailCount = 0;
        tunnelRestarts = 0; // reset on success
        return;
      }
    } catch {}
    tunnelFailCount++;
    if (tunnelFailCount >= TUNNEL_PROBE_FAIL_THRESHOLD && tunnelChild) {
      log("WARN", `Tunnel URL dead (${tunnelFailCount} failures), regenerating`);
      try { tunnelChild.kill(); } catch {}
      tunnelFailCount = 0;
      // spawnTunnel loop handles respawn via exited promise
    }
  }, TUNNEL_PROBE_INTERVAL_MS);
}

// ─── Shutdown ──────────────────────────────────────────────────────────
export function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("INFO", "Supervisor shutting down");

  if (healthTimer) clearInterval(healthTimer);
  if (tunnelProbeTimer) clearInterval(tunnelProbeTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  if (serverChild) { try { serverChild.kill(); } catch {} }
  if (tunnelChild) { try { tunnelChild.kill(); } catch {} }
}

// ─── Main entry ────────────────────────────────────────────────────────
export async function runSupervisor(opts: {
  port: number;
  host: string;
  config?: string;
  profile?: string;
  share: boolean;
}) {
  if (!existsSync(PPM_DIR)) mkdirSync(PPM_DIR, { recursive: true });

  const logFd = openSync(LOG_FILE, "a");
  log("INFO", `Supervisor started (PID: ${process.pid}, port: ${opts.port}, share: ${opts.share})`);

  // Write supervisor PID
  writeFileSync(PID_FILE, String(process.pid));
  updateStatus({ supervisorPid: process.pid, port: opts.port, host: opts.host });

  // Build __serve__ args
  const serverArgs = [
    "__serve__", String(opts.port), opts.host,
    opts.config ?? "", opts.profile ?? "",
  ];
  // Strip trailing empty args
  while (serverArgs.length > 0 && serverArgs[serverArgs.length - 1] === "") serverArgs.pop();

  // Signal handlers
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });
  process.on("SIGINT", () => { shutdown(); process.exit(0); });

  // SIGUSR2 = graceful server restart (tunnel stays alive)
  process.on("SIGUSR2", () => {
    log("INFO", "SIGUSR2 received, restarting server only");
    if (serverChild) {
      serverRestartRequested = true; // flag so spawnServer skips backoff
      try { serverChild.kill(); } catch {}
    }
  });

  // Start health checks
  startServerHealthCheck(opts.port);

  // Spawn server + tunnel in parallel
  const promises: Promise<void>[] = [spawnServer(serverArgs, logFd)];

  if (opts.share) {
    startTunnelProbe(opts.port);
    promises.push(spawnTunnel(opts.port));
  }

  await Promise.all(promises);

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
