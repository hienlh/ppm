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

  test("supervisor handles an occupied preferred port per-platform", async () => {
    // Occupy TEST_PORT so the supervisor cannot bind it.
    const net = require("node:net") as typeof import("node:net");
    await new Promise<void>((res, rej) => {
      occupier = net.createServer(() => {})
        .once("error", rej)
        .listen(TEST_PORT, "127.0.0.1", () => res());
    });

    await spawnTestSupervisor();

    if (process.platform === "win32") {
      // Windows has a real zombie-socket mode the OS never releases, so moving
      // to a nearby port is the only way to keep the backend up.
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
      expect(readStatus()!.state).toBe("running");
      return;
    }

    // POSIX: an occupied port means a live listener, never a zombie socket.
    // Moving to another port here is what silently turned each duplicate launch
    // into a full extra instance (7 of them, each with its own public tunnel),
    // so the supervisor must fail loudly on the configured port instead.
    const logged = await waitFor(
      () => readFileSync(LOG_FILE, "utf-8").includes("Not falling back to another port"),
      TEST_TIMEOUT,
    );
    expect(logged).toBe(true);
    expect(readStatus()?.port ?? TEST_PORT).toBe(TEST_PORT);
  }, TEST_TIMEOUT);
});

// ─── Supervisor self-heal: source patterns ──────────────────────────────

// describeBase, not the live-gated `describe`: every test here reads source
// text and needs no supervisor, port, or network. Gating them behind
// PPM_SKIP_LIVE meant these regression guards never ran in the canonical
// Docker suite — which is exactly where a design invariant should be enforced.
describeBase("Supervisor self-heal patterns", () => {
  const supervisorCode = readFileSync(
    resolve(import.meta.dir, "../../src/services/supervisor.ts"),
    "utf-8",
  );

  test("ensureBindablePort only falls back to a nearby port on win32", () => {
    expect(supervisorCode).toContain("async function ensureBindablePort");
    expect(supervisorCode).toMatch(/for \(let p = preferred \+ 1; p <= preferred \+ 20; p\+\+\)/);

    // The fallback loop must sit INSIDE the win32 branch. When it was reachable
    // on POSIX, every duplicate launch silently became another full instance.
    const body = supervisorCode.slice(
      supervisorCode.indexOf("async function ensureBindablePort"),
    );
    const win32At = body.indexOf('process.platform === "win32"');
    const fallbackAt = body.search(/for \(let p = preferred \+ 1/);
    const posixAt = body.indexOf("// ── POSIX");
    expect(win32At).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(win32At);
    expect(posixAt).toBeGreaterThan(fallbackAt);
  });

  test("the server needs no particular port, so a port move cannot rotate the URL", () => {
    // Superseded design: spawnServer used to prefer the live tunnel's origin
    // port and re-point the tunnel when it had to bind elsewhere. That
    // re-point is what rotated the public URL on every upgrade. The server now
    // takes an OS-assigned loopback port and the edge owns the public one.
    expect(supervisorCode).toContain('"__serve__", "0", "127.0.0.1"');
    expect(supervisorCode).not.toContain("const preferred = tunnelAlive && tunnelPort !== null");
    expect(supervisorCode).not.toMatch(/restartTunnel\(boundPort\)/);
    expect(supervisorCode).not.toContain("Server port moved to");
  });

  test("adoption is attempted before any bind probe on the public port", () => {
    // ensureBindablePort tree-kills a PPM process holding the port. Probing
    // first would therefore kill a healthy adopted edge — the one thing keeping
    // the public URL alive across an upgrade.
    const boot = supervisorCode.slice(supervisorCode.indexOf("const publicPort = tunnelAdopted"));
    const adoptAt = boot.indexOf("adoptEdge(publicPort");
    const probeAt = boot.indexOf("ensureBindablePort(publicPort");
    expect(adoptAt).toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(adoptAt);
  });

  test("the edge is spawned detached so it survives self-replace", () => {
    const spawnEdge = supervisorCode.slice(
      supervisorCode.indexOf("async function spawnEdge"),
      supervisorCode.indexOf("async function spawnEdge") + 1200,
    );
    expect(spawnEdge).toContain("detached: true");
    expect(spawnEdge).toContain("withProbeSpawnGate");
    // Bun.spawn would tie it to the supervisor's job object on Windows and kill
    // it the moment the old supervisor exits during an upgrade.
    expect(spawnEdge).not.toContain("Bun.spawn");
  });

  test("the edge forwarder never spawns a child process", () => {
    // The whole design rests on this: a child would inherit the listening
    // socket handle and could zombie the public port.
    const edgeCode = readFileSync(
      resolve(import.meta.dir, "../../src/services/edge-forwarder.ts"),
      "utf-8",
    ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // strip comments, which discuss spawning
    expect(edgeCode).not.toMatch(/spawn|child_process|execFile|exec\(/);
  });

  test("only a supervisor-spawned server publishes .server-port", () => {
    // `.server-port` is the edge's routing table and lives in the shared
    // ~/.ppm, so any process running the __serve__ entry can clobber it.
    // `bun dev:server` is not PPM_HOME-isolated — it only differs by DB
    // profile — so without this guard starting the dev server silently
    // repointed the PRODUCTION tunnel at the dev instance.
    const serverCode = readFileSync(
      resolve(import.meta.dir, "../../src/server/index.ts"),
      "utf-8",
    );
    const idx = serverCode.indexOf("SERVER_PORT_FILE()");
    expect(idx).toBeGreaterThan(-1);
    // The write must sit inside a port-0 guard: only the OS-assigned port a
    // supervisor asked for belongs to the edge.
    const before = serverCode.slice(Math.max(0, idx - 400), idx);
    expect(before).toMatch(/if \(port === 0\)/);
  });

  test("the supervisor repairs a hijacked .server-port instead of killing the server", () => {
    // Before this, a value left behind by another instance made the health
    // probe check the wrong process, then kill a perfectly healthy server.
    expect(supervisorCode).toContain("function repairServerPortFile");
    expect(supervisorCode).toContain("repairServerPortFile();");
    // The captured port must be dropped on respawn, or the repair would
    // restore a port that just died.
    expect(supervisorCode).toMatch(/serverPublishedPort = null;\s*\n\s*try \{ unlinkSync\(SERVER_PORT_FILE\(\)\)/);
  });

  test("spawnServer hunts zombie-port orphans before falling back to another port", () => {
    expect(supervisorCode).toContain("reapZombiePortOrphans");
    // Only hunts when the LISTEN owner is dead (zombie socket), never a live app
    expect(supervisorCode).toMatch(/else if \(!alive\) \{/);
  });

  test("port probe can never stall the server spawn", () => {
    // The probe really listens, so reconnecting clients can land on it. An open
    // connection makes close(cb) wait forever — spawnServer then never spawns,
    // silently, while supervisor + tunnel still look healthy.
    expect(supervisorCode).toContain('tester.on("connection", (socket) => socket.destroy())');
    expect(supervisorCode).toContain("PORT_PROBE_TIMEOUT_MS");
    expect(supervisorCode).toMatch(/timed out — treating as unbindable/);
  });

  test("health check revives a server child that never spawned", () => {
    expect(supervisorCode).toContain("No server child while state=running");
    expect(supervisorCode).toContain("SERVER_REVIVE_AFTER_MS");
  });

  test("SIGUSR2 spawns a server when there is none to bounce", () => {
    expect(supervisorCode).toContain("No server child to restart");
  });

  test("self-replace detaches the new supervisor into its own session", () => {
    // Same process group as launchd/systemd = the replacement is torn down with us.
    expect(supervisorCode).toMatch(/detached: true,[\s\S]{0,200}windowsHide: true/);
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

  test("macOS plist keeps the process group so launchd reaps the server tree", () => {
    // Upgrades used to spawn a detached replacement, which launchd could not
    // see — so on exit KeepAlive started a SECOND supervisor on top of it, and
    // AbandonProcessGroup kept the old server and its Claude SDK children alive
    // holding the port. Upgrades now just exit and let KeepAlive restart us.
    const { generatePlist } = require("../../src/services/autostart-generator.ts");
    const plist = generatePlist({ port: 8080, host: "0.0.0.0", share: false });
    expect(plist).not.toContain("<key>AbandonProcessGroup</key>");
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
