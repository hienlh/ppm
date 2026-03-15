import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test";

setDefaultTimeout(60_000); // Tunnel tests need time for cloudflared
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const STATUS_FILE = resolve(homedir(), ".ppm", "status.json");
const PID_FILE = resolve(homedir(), ".ppm", "ppm.pid");
const PORT = 9876; // Use uncommon port to avoid conflicts
const CLI = resolve(import.meta.dir, "../../src/index.ts");

/** Run ppm CLI command and return stdout */
async function ppm(args: string, timeout = 40_000): Promise<string> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args.split(" ")], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, NODE_ENV: "test" },
  });
  const timer = setTimeout(() => proc.kill(), timeout);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  await proc.exited;
  return out;
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
      if (s.pid) killSafe(s.pid);
      if (s.tunnelPid) killSafe(s.tunnelPid);
    } catch {}
    try { unlinkSync(STATUS_FILE); } catch {}
  }
  if (existsSync(PID_FILE)) try { unlinkSync(PID_FILE); } catch {}
}

afterAll(() => cleanupAll());

describe("Daemon + Tunnel lifecycle", () => {
  it("ppm start creates status.json with pid", async () => {
    cleanupAll();
    await ppm(`start -p ${PORT}`);

    expect(existsSync(STATUS_FILE)).toBe(true);
    const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    expect(status.pid).toBeGreaterThan(0);
    expect(status.port).toBe(PORT);
    expect(isAlive(status.pid)).toBe(true);
  });

  it("ppm stop kills server and cleans up files", async () => {
    const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    const serverPid = status.pid;

    await ppm("stop");

    expect(isAlive(serverPid)).toBe(false);
    expect(existsSync(STATUS_FILE)).toBe(false);
  });
});

describe("Tunnel survives server crash", () => {
  let serverPid: number;
  let tunnelPid: number;
  let shareUrl: string;

  it("ppm start --share spawns server + independent tunnel", async () => {
    cleanupAll();
    const out = await ppm(`start --share -p ${PORT}`, 60_000);

    expect(existsSync(STATUS_FILE)).toBe(true);
    const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    serverPid = status.pid;
    tunnelPid = status.tunnelPid;
    shareUrl = status.shareUrl;

    expect(serverPid).toBeGreaterThan(0);
    expect(tunnelPid).toBeGreaterThan(0);
    expect(shareUrl).toMatch(/trycloudflare\.com/);
    expect(isAlive(serverPid)).toBe(true);
    expect(isAlive(tunnelPid)).toBe(true);
  });

  it("killing server does NOT kill tunnel", async () => {
    // Kill only the server process (simulating crash)
    killSafe(serverPid);
    await Bun.sleep(500);

    expect(isAlive(serverPid)).toBe(false);
    expect(isAlive(tunnelPid)).toBe(true); // Tunnel survives!
  });

  it("ppm start --share reuses existing tunnel with same domain", async () => {
    // Restart server with --share — should detect tunnel alive
    const out = await ppm(`start --share -p ${PORT}`, 60_000);

    const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    const newServerPid = status.pid;

    // New server process
    expect(newServerPid).toBeGreaterThan(0);
    expect(newServerPid).not.toBe(serverPid); // Different PID

    // Same tunnel — NOT restarted
    expect(status.tunnelPid).toBe(tunnelPid); // Same tunnel PID
    expect(status.shareUrl).toBe(shareUrl);   // Same domain!
    expect(isAlive(tunnelPid)).toBe(true);

    // Update for cleanup
    serverPid = newServerPid;
  });

  it("ppm stop kills both server and tunnel", async () => {
    await ppm("stop");
    await Bun.sleep(1000); // Wait for processes to fully exit

    expect(isAlive(serverPid)).toBe(false);
    expect(isAlive(tunnelPid)).toBe(false);
    expect(existsSync(STATUS_FILE)).toBe(false);
  });
});
