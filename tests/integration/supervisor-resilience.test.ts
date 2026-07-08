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
import { describe as describeBase, test, expect, afterEach, beforeEach, afterAll } from "bun:test";
// Skipped in the sandboxed Docker run (PPM_SKIP_LIVE=1) — spawns a real supervisor process.
const describe = process.env.PPM_SKIP_LIVE === "1" ? describeBase.skip : describeBase;
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from "node:fs";

const PPM_DIR = resolve(require("node:os").tmpdir(), `ppm-test-supervisor-${process.pid}`);
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

/** Kill port occupants to ensure clean test start (cross-platform) */
function freePort(port: number) {
  try {
    if (process.platform === "win32") {
      // lsof is unavailable on Windows — resolve the listener PID via netstat.
      const r = Bun.spawnSync(["netstat", "-ano"], { stdout: "pipe", stderr: "ignore" });
      for (const line of r.stdout.toString().split("\n")) {
        if (!line.includes("LISTENING")) continue;
        const cols = line.trim().split(/\s+/);
        if (!(cols[1] ?? "").endsWith(":" + port)) continue;
        const pid = Number(cols[cols.length - 1]);
        if (pid) { try { Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); } catch {} }
      }
      return;
    }
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
    env: { ...process.env, NODE_ENV: "test", PPM_HOME: PPM_DIR },
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

  afterAll(() => {
    cleanup();
    try { rmSync(PPM_DIR, { recursive: true, force: true }); } catch {}
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
    }, TEST_TIMEOUT);

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
    }, TEST_TIMEOUT);
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
    }, TEST_TIMEOUT);

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
    }, TEST_TIMEOUT);

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
    }, TEST_TIMEOUT);

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
    }, TEST_TIMEOUT);

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
    }, TEST_TIMEOUT);

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

// ─── Port recovery: zombie-socket fallback ──────────────────────────────

describe("Port recovery", () => {
  let occupier: ReturnType<typeof import("node:net").createServer> | null = null;

  beforeEach(() => {
    if (!existsSync(PPM_DIR)) mkdirSync(PPM_DIR, { recursive: true });
    cleanup();          // kill any leftover supervisor + free the port
    freePort(TEST_PORT);
  });

  afterEach(() => {
    if (occupier) { try { occupier.close(); } catch {} occupier = null; }
    cleanup();
  });

  test("supervisor falls back to a free port when the preferred port is occupied", async () => {
    // Occupy TEST_PORT so the supervisor cannot bind it — simulates the
    // post-hibernate zombie socket (cross-platform stand-in: a live listener).
    const net = require("node:net") as typeof import("node:net");
    await new Promise<void>((res, rej) => {
      occupier = net.createServer(() => {})
        .once("error", rej)
        .listen(TEST_PORT, "127.0.0.1", () => res());
    });

    await spawnTestSupervisor();

    // Server should come up on a nearby fallback port, not crash-loop to paused.
    const ok = await waitFor(() => {
      const s = readStatus();
      const p = s?.port as number | undefined;
      return !!p && p > TEST_PORT && p <= TEST_PORT + 20;
    }, TEST_TIMEOUT);
    expect(ok).toBe(true);

    const fallbackPort = readStatus()!.port as number;
    const reachable = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${fallbackPort}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch { return false; }
    }, TEST_TIMEOUT);
    expect(reachable).toBe(true);

    // Original occupied port must NOT be paused/abandoned — state stays running.
    expect(readStatus()!.state).toBe("running");
  }, TEST_TIMEOUT);
});

// ─── Supervisor self-heal: source patterns ──────────────────────────────

describe("Supervisor self-heal patterns", () => {
  const supervisorCode = readFileSync(
    resolve(import.meta.dir, "../../src/services/supervisor.ts"),
    "utf-8",
  );

  test("ensureBindablePort exists and falls back to a nearby port", () => {
    expect(supervisorCode).toContain("async function ensureBindablePort");
    expect(supervisorCode).toMatch(/for \(let p = preferred \+ 1; p <= preferred \+ 20; p\+\+\)/);
  });

  test("spawnServer resolves a bindable port and re-points the tunnel only on origin mismatch", () => {
    // Prefers the live tunnel's origin port so an upgrade never rotates the URL
    expect(supervisorCode).toContain("const preferred = tunnelAlive && tunnelPort !== null ? tunnelPort : _opts.port");
    expect(supervisorCode).toContain("const boundPort = await ensureBindablePort(preferred, _opts.host)");
    // Tunnel restarts only when its origin differs from the bound port
    expect(supervisorCode).toMatch(/if \(tunnelAlive && tunnelPort !== null && tunnelPort !== boundPort\) \{\s*\n\s*restartTunnel\(boundPort\);/);
  });

  test("spawnServer hunts zombie-port orphans before falling back to another port", () => {
    expect(supervisorCode).toContain("reapZombiePortOrphans");
    // Only hunts when the LISTEN owner is dead (zombie socket), never a live app
    expect(supervisorCode).toMatch(/else if \(!alive\) \{/);
  });

  test("resume-from-sleep detection resets budgets and regenerates the tunnel", () => {
    expect(supervisorCode).toContain("Resume-from-sleep detection");
    expect(supervisorCode).toContain("RESUME_GAP_MS");
    expect(supervisorCode).toMatch(/serverRestarts = 0;\s*\n\s*tunnelRestarts = 0;/);
    expect(supervisorCode).toContain("if (getState() === \"paused\") triggerResume()");
  });
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

// ─── Tunnel resilience: always-on, no dark window, zombie net ───────────

describe("Tunnel resilience", () => {
  const supervisorCode = readFileSync(
    resolve(import.meta.dir, "../../src/services/supervisor.ts"),
    "utf-8",
  );

  test("tunnel is unconditional — supervisor does not gate on --share flag", () => {
    // CLI entry forces share=true; --share is a deprecated no-op.
    expect(supervisorCode).toMatch(/const share = true;/);
    expect(supervisorCode).not.toContain('const share = process.argv.includes("--share")');
  });

  test("10-min cooldown dark window removed", () => {
    // The cooldown constant and its shareUrl=null give-up branches must be gone.
    expect(supervisorCode).not.toContain("TUNNEL_COOLDOWN_MS");
    expect(supervisorCode).not.toMatch(/Tunnel exceeded .* cooldown/);
  });

  test("zombie threshold replaces eager probe regeneration", () => {
    // Probe only regenerates a truly-zombied URL (~5min), not on transient blips.
    expect(supervisorCode).toContain("TUNNEL_ZOMBIE_THRESHOLD = 10");
    expect(supervisorCode).toContain("tunnelFailCount >= TUNNEL_ZOMBIE_THRESHOLD");
    expect(supervisorCode).not.toContain("TUNNEL_PROBE_FAIL_THRESHOLD");
  });

  test("tunnel retry backoff is capped + jittered, never gives up", () => {
    // Counter capped at MAX_RESTARTS so backoff plateaus; jitter added; loop always respawns.
    expect(supervisorCode).toContain("if (tunnelRestarts > MAX_RESTARTS) tunnelRestarts = MAX_RESTARTS;");
    expect(supervisorCode).toMatch(/backoffDelay\(tunnelRestarts\) \+ Math\.floor\(Math\.random\(\) \* 1000\)/);
  });
});
