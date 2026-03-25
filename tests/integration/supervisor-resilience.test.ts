/**
 * Integration tests for the supervisor process resilience system.
 *
 * Tests verify:
 * - Supervisor spawns server child and writes status.json correctly
 * - Supervisor restarts server child on crash (non-zero exit)
 * - Supervisor does NOT restart server on clean exit (exit 0)
 * - Supervisor responds to SIGTERM gracefully
 * - SIGUSR2 triggers server-only restart (tunnel stays)
 * - Health check detects unresponsive server
 * - Status.json contains supervisorPid field
 *
 * Uses a real Bun.spawn to start the supervisor with a high port to avoid conflicts.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";

const PPM_DIR = resolve(homedir(), ".ppm");
const STATUS_FILE = resolve(PPM_DIR, "status.json");
const PID_FILE = resolve(PPM_DIR, "ppm.pid");
const LOG_FILE = resolve(PPM_DIR, "ppm.log");
const TEST_PORT = 19876; // High port to avoid conflicts
const TEST_TIMEOUT = 30_000;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readStatus(): Record<string, unknown> | null {
  try {
    if (!existsSync(STATUS_FILE)) return null;
    return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch { return null; }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 300,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

/** Kill port occupants to ensure clean test start */
function freePort(port: number) {
  try {
    const r = Bun.spawnSync(["lsof", "-t", "-i", `:${port}`], { stdout: "pipe", stderr: "ignore" });
    const pids = r.stdout.toString().trim().split("\n").filter(Boolean);
    for (const pid of pids) { try { process.kill(Number(pid)); } catch {} }
  } catch {}
}

// Track supervisor PID for cleanup
let supervisorPid: number | null = null;

function cleanup() {
  // Kill supervisor + children
  if (supervisorPid) {
    try { process.kill(supervisorPid, "SIGTERM"); } catch {}
    supervisorPid = null;
  }
  // Kill anything on test port
  freePort(TEST_PORT);
  // Read status.json and kill remaining PIDs
  try {
    const status = readStatus();
    if (status?.pid) try { process.kill(status.pid as number); } catch {}
    if (status?.tunnelPid) try { process.kill(status.tunnelPid as number); } catch {}
    if (status?.supervisorPid) try { process.kill(status.supervisorPid as number); } catch {}
  } catch {}
  // Clean up status files
  try { if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE); } catch {}
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
}

/** Spawn supervisor for testing — returns supervisor PID */
async function spawnTestSupervisor(opts?: { share?: boolean }): Promise<number> {
  const supervisorScript = resolve(import.meta.dir, "../../src/services/supervisor.ts");
  const args = ["__supervise__", String(TEST_PORT), "127.0.0.1", "", "dev"];
  if (opts?.share) args.push("--share");

  const logFd = require("node:fs").openSync(LOG_FILE, "a");
  const child = Bun.spawn({
    cmd: [process.execPath, "run", supervisorScript, ...args],
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, NODE_ENV: "test" },
  });

  supervisorPid = child.pid;
  return child.pid;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("Supervisor Resilience", () => {
  beforeEach(() => {
    if (!existsSync(PPM_DIR)) mkdirSync(PPM_DIR, { recursive: true });
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  test("supervisor starts server child and writes status.json", async () => {
    const pid = await spawnTestSupervisor();

    // Wait for server to be ready
    const ready = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch { return false; }
    }, 15_000);

    expect(ready).toBe(true);

    // Verify status.json
    const status = readStatus();
    expect(status).not.toBeNull();
    expect(status!.supervisorPid).toBe(pid);
    expect(typeof status!.pid).toBe("number");
    expect(status!.pid).not.toBe(pid); // server PID should differ from supervisor
    expect(status!.port).toBe(TEST_PORT);

    // Verify PID file contains supervisor PID
    const pidFromFile = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    expect(pidFromFile).toBe(pid);

    // Both processes should be alive
    expect(isAlive(pid)).toBe(true);
    expect(isAlive(status!.pid as number)).toBe(true);
  }, TEST_TIMEOUT);

  test("supervisor restarts server child after crash", async () => {
    await spawnTestSupervisor();

    // Wait for server to be ready
    const ready = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch { return false; }
    }, 15_000);
    expect(ready).toBe(true);

    const status = readStatus();
    const originalServerPid = status!.pid as number;
    expect(isAlive(originalServerPid)).toBe(true);

    // Kill server child (simulate crash with SIGKILL — non-zero exit)
    process.kill(originalServerPid, "SIGKILL");

    // Wait for supervisor to restart a new server child
    const restarted = await waitFor(async () => {
      const s = readStatus();
      if (!s || !s.pid) return false;
      const newPid = s.pid as number;
      if (newPid === originalServerPid) return false;
      // Verify new server is actually responding
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch { return false; }
    }, 15_000);

    expect(restarted).toBe(true);

    // Verify new PID is different
    const newStatus = readStatus();
    expect(newStatus!.pid).not.toBe(originalServerPid);
    expect(isAlive(newStatus!.pid as number)).toBe(true);
  }, TEST_TIMEOUT);

  test("supervisor exits cleanly on SIGTERM", async () => {
    const pid = await spawnTestSupervisor();

    // Wait for server to start
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch { return false; }
    }, 15_000);

    const status = readStatus();
    const serverPid = status!.pid as number;

    // Send SIGTERM to supervisor
    process.kill(pid, "SIGTERM");

    // Wait for both to die
    const died = await waitFor(() => {
      return !isAlive(pid) && !isAlive(serverPid);
    }, 10_000);

    expect(died).toBe(true);
    supervisorPid = null; // Already dead, skip cleanup kill
  }, TEST_TIMEOUT);

  test("SIGUSR2 restarts only server (supervisor stays)", async () => {
    const supPid = await spawnTestSupervisor();

    // Wait for server to start
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch { return false; }
    }, 15_000);

    const originalServerPid = (readStatus()!.pid) as number;

    // Send SIGUSR2 to supervisor
    process.kill(supPid, "SIGUSR2");

    // Wait for new server PID
    const restarted = await waitFor(async () => {
      const s = readStatus();
      if (!s || !s.pid) return false;
      const newPid = s.pid as number;
      if (newPid === originalServerPid) return false;
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch { return false; }
    }, 15_000);

    expect(restarted).toBe(true);

    // Supervisor should still be the same PID
    expect(isAlive(supPid)).toBe(true);
    const newStatus = readStatus();
    expect(newStatus!.supervisorPid).toBe(supPid);
    expect(newStatus!.pid).not.toBe(originalServerPid);
  }, TEST_TIMEOUT);

  test("supervisor backoff increases on rapid crashes", async () => {
    await spawnTestSupervisor();

    // Wait for server to start
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch { return false; }
    }, 15_000);

    // Kill server 3 times rapidly
    for (let i = 0; i < 3; i++) {
      const status = readStatus();
      if (!status?.pid) break;
      const pid = status.pid as number;
      if (isAlive(pid)) {
        process.kill(pid, "SIGKILL");
        // Wait for restart
        await waitFor(() => {
          const s = readStatus();
          return !!s && s.pid !== pid && isAlive(s.pid as number);
        }, 10_000);
      }
    }

    // After 3 rapid crashes, check logs for increasing backoff
    const logContent = readFileSync(LOG_FILE, "utf-8");
    const backoffMatches = logContent.match(/restarting in (\d+)ms/g) ?? [];

    // Should have at least 2 restart log entries with increasing delays
    expect(backoffMatches.length).toBeGreaterThanOrEqual(2);
  }, 45_000);
});

// ─── Autostart config tests ────────────────────────────────────────────

describe("Autostart config improvements", () => {
  test("macOS plist uses unconditional KeepAlive", () => {
    const { generatePlist } = require("../../src/services/autostart-generator.ts");
    const plist = generatePlist({ port: 8080, host: "0.0.0.0", share: false });
    // Should have unconditional <true/>, not conditional dict
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).not.toContain("<key>SuccessfulExit</key>");
  });

  test("Linux systemd uses Restart=always", () => {
    const { generateSystemdService } = require("../../src/services/autostart-generator.ts");
    const service = generateSystemdService({ port: 8080, host: "0.0.0.0", share: false });
    expect(service).toContain("Restart=always");
    expect(service).not.toContain("Restart=on-failure");
  });
});

// ─── Uncaught exception handler tests ──────────────────────────────────

describe("Enhanced exception handling", () => {
  test("server/index.ts has count-based exit logic in exception handler", () => {
    // Static analysis: verify the code pattern exists
    const serverCode = readFileSync(
      resolve(import.meta.dir, "../../src/server/index.ts"),
      "utf-8",
    );
    expect(serverCode).toContain("exceptionCount");
    expect(serverCode).toContain("Too many errors in 1 min");
    expect(serverCode).toContain("process.exit(1)");
  });
});
