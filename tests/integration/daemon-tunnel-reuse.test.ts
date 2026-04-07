import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test";

setDefaultTimeout(60_000); // Tunnel tests need time for cloudflared
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";

const PPM_DIR = resolve(require("node:os").tmpdir(), `ppm-test-daemon-${process.pid}`);
const STATUS_FILE = resolve(PPM_DIR, "status.json");
const PID_FILE = resolve(PPM_DIR, "ppm.pid");
// Isolated DB profile for this test — uses isolated PPM_DIR
const TEST_PROFILE = "daemon-test";
const TEST_DB = resolve(PPM_DIR, `ppm.${TEST_PROFILE}.db`);
const PORT = 9876; // Use uncommon port to avoid conflicts
const CLI = resolve(import.meta.dir, "../../src/index.ts");

/** Run ppm CLI command and return stdout */
async function ppm(args: string, timeout = 40_000): Promise<string> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args.split(" ")], {
    stdout: "pipe", stderr: "pipe",
    stdin: "ignore", // Prevent interactive prompts from blocking
    env: { ...process.env, NODE_ENV: "test", PPM_HOME: PPM_DIR },
  });
  const timer = setTimeout(() => proc.kill(), timeout);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  await proc.exited;
  return out;
}

/** Pre-init the test DB so ppm start doesn't block on interactive setup */
function ensureTestDb() {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  if (!existsSync(PPM_DIR)) require("node:fs").mkdirSync(PPM_DIR, { recursive: true });
  const dbPath = resolve(PPM_DIR, `ppm.${TEST_PROFILE}.db`);
  // Remove stale DB to avoid lock issues
  try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch {}
  const db = new Database(dbPath);
  db.run("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT OR REPLACE INTO config (key, value) VALUES ('port', ?)", [String(PORT)]);
  db.run("INSERT OR REPLACE INTO config (key, value) VALUES ('host', '127.0.0.1')");
  db.run("INSERT OR REPLACE INTO config (key, value) VALUES ('device_name', 'test-device')");
  db.run("INSERT OR REPLACE INTO config (key, value) VALUES ('auth', '{\"enabled\":false}')");
  db.close();
}

/** Check if a process is alive */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Kill process safely */
function killSafe(pid: number) {
  try { process.kill(pid); } catch {}
}

/** Cleanup all PPM processes */
function cleanupAll() {
  if (existsSync(STATUS_FILE)) {
    try {
      const s = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
      if (s.supervisorPid) killSafe(s.supervisorPid);
      if (s.pid) killSafe(s.pid);
      if (s.tunnelPid) killSafe(s.tunnelPid);
    } catch {}
    try { unlinkSync(STATUS_FILE); } catch {}
  }
  if (existsSync(PID_FILE)) try { unlinkSync(PID_FILE); } catch {}
  // Free port in case of orphan processes
  try {
    const r = Bun.spawnSync(["lsof", "-t", "-i", `:${PORT}`], { stdout: "pipe", stderr: "ignore" });
    const pids = r.stdout.toString().trim().split("\n").filter(Boolean);
    for (const pid of pids) { try { process.kill(Number(pid)); } catch {} }
  } catch {}
}

afterAll(() => {
  cleanupAll();
  // Clean up entire isolated test dir
  try { rmSync(PPM_DIR, { recursive: true, force: true }); } catch {}
});

describe("Daemon + Tunnel lifecycle", () => {
  it("ppm start creates status.json with supervisor + server pid", async () => {
    cleanupAll();
    ensureTestDb();
    await ppm(`start -p ${PORT} --profile ${TEST_PROFILE}`);

    expect(existsSync(STATUS_FILE)).toBe(true);
    const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    expect(status.pid).toBeGreaterThan(0);
    expect(status.port).toBe(PORT);
    expect(status.supervisorPid).toBeGreaterThan(0);
    expect(status.supervisorPid).not.toBe(status.pid); // different processes
    expect(isAlive(status.pid)).toBe(true);
    expect(isAlive(status.supervisorPid)).toBe(true);
  });

  it("ppm stop (soft) kills server but keeps supervisor alive", async () => {
    if (!existsSync(STATUS_FILE)) {
      console.warn("[skip] status.json not found — start test likely failed");
      return;
    }
    const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    const serverPid = status.pid;
    const supPid = status.supervisorPid;

    await ppm("stop");
    await Bun.sleep(2500); // Allow supervisor to process soft stop

    expect(isAlive(serverPid)).toBe(false);
    // Supervisor stays alive after soft stop
    if (supPid) expect(isAlive(supPid)).toBe(true);
    // status.json should still exist with state: "stopped"
    expect(existsSync(STATUS_FILE)).toBe(true);
    const newStatus = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    expect(newStatus.state).toBe("stopped");

    // Full cleanup via --kill
    await ppm("stop --kill");
    await Bun.sleep(2000);
    if (supPid) expect(isAlive(supPid)).toBe(false);
    if (existsSync(STATUS_FILE)) {
      cleanupAll();
    }
  });
});

describe("Tunnel survives server crash", () => {
  let serverPid: number;
  let tunnelPid: number;
  let shareUrl: string;

  // Check if cloudflared is available — skip entire block if not
  const cloudflaredAvailable = (() => {
    try {
      const r = Bun.spawnSync({ cmd: ["which", "cloudflared"], stdout: "pipe" });
      if (r.exitCode === 0) return true;
      return existsSync(resolve(homedir(), ".ppm", "cloudflared"));
    } catch { return false; }
  })();

  it("ppm start --share spawns supervisor + server + tunnel", async () => {
    if (!cloudflaredAvailable) {
      console.warn("[skip] cloudflared not installed — skipping tunnel tests");
      return;
    }
    cleanupAll();
    ensureTestDb();
    const out = await ppm(`start --share -p ${PORT} --profile ${TEST_PROFILE}`, 60_000);

    expect(existsSync(STATUS_FILE)).toBe(true);
    const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    serverPid = status.pid;
    tunnelPid = status.tunnelPid;
    shareUrl = status.shareUrl;

    expect(serverPid).toBeGreaterThan(0);
    expect(status.supervisorPid).toBeGreaterThan(0);
    // Tunnel may need a moment — supervisor spawns it async
    if (tunnelPid) {
      expect(tunnelPid).toBeGreaterThan(0);
      expect(isAlive(tunnelPid)).toBe(true);
    }
    if (shareUrl) {
      expect(shareUrl).toMatch(/trycloudflare\.com/);
    }
    expect(isAlive(serverPid)).toBe(true);
  });

  it("killing server does NOT kill tunnel — supervisor restarts server", async () => {
    if (!cloudflaredAvailable || !tunnelPid) return;
    // Kill only the server process (simulating crash)
    killSafe(serverPid);
    await Bun.sleep(3000); // Wait for supervisor to restart server

    // Tunnel should still be alive
    if (tunnelPid) expect(isAlive(tunnelPid)).toBe(true);

    // Supervisor should have restarted the server with a new PID
    const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    const newServerPid = status.pid;
    expect(newServerPid).toBeGreaterThan(0);
    expect(isAlive(newServerPid)).toBe(true);

    // Update for cleanup
    serverPid = newServerPid;
  });

  it("ppm stop --kill kills supervisor, server and tunnel", async () => {
    if (!cloudflaredAvailable || !tunnelPid) return;
    await ppm("stop --kill");
    await Bun.sleep(2500); // Wait for supervisor to gracefully kill children

    expect(isAlive(serverPid)).toBe(false);
    if (tunnelPid) expect(isAlive(tunnelPid)).toBe(false);
    expect(existsSync(STATUS_FILE)).toBe(false);
  });
});
