import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, unlinkSync, existsSync } from "node:fs";

const PID_FILE = resolve(homedir(), ".ppm", "ppm.pid");
const STATUS_FILE = resolve(homedir(), ".ppm", "status.json");

function killPid(pid: number, label: string): boolean {
  try {
    process.kill(pid);
    console.log(`  Stopped ${label} (PID: ${pid})`);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ESRCH") console.error(`  Failed to stop ${label}: ${err.message}`);
    return false;
  }
}

function findPidsByName(name: string): number[] {
  try {
    if (process.platform === "win32") {
      // Windows: use wmic to find processes
      const result = Bun.spawnSync(
        ["wmic", "process", "where", `CommandLine like '%${name}%'`, "get", "ProcessId", "/format:csv"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const output = result.stdout.toString().trim();
      if (!output) return [];
      return output.split("\n").slice(1)
        .map((line) => parseInt(line.trim().split(",").pop() ?? "", 10))
        .filter((pid) => !isNaN(pid) && pid !== process.pid);
    }
    // macOS/Linux: use pgrep
    const result = Bun.spawnSync(["pgrep", "-fl", name], { stdout: "pipe", stderr: "ignore" });
    const output = result.stdout.toString().trim();
    if (!output) return [];
    return output.split("\n")
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => !isNaN(pid) && pid !== process.pid);
  } catch { return []; }
}

function killAllByName(name: string): number {
  const pids = findPidsByName(name);
  let killed = 0;
  for (const pid of pids) {
    if (killPid(pid, name)) killed++;
  }
  return killed;
}

export async function stopServer(options?: { all?: boolean }) {
  if (options?.all) {
    console.log("  Stopping all PPM and cloudflared processes...\n");
    const cfKilled = killAllByName("cloudflared");
    // Kill bun processes listening on PPM ports (from status.json or common ports)
    let serverKilled = 0;
    if (existsSync(STATUS_FILE)) {
      try {
        const data = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
        if (data.pid) { killPid(data.pid, "server"); serverKilled++; }
      } catch {}
    }
    if (existsSync(PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (!isNaN(pid)) { killPid(pid, "server (pidfile)"); serverKilled++; }
      } catch {}
    }
    cleanup();
    console.log(`\n  Done. Killed ${cfKilled} cloudflared + ${serverKilled} server process(es).`);
    return;
  }

  let status: { pid?: number; tunnelPid?: number } | null = null;

  // Read status.json
  if (existsSync(STATUS_FILE)) {
    try { status = JSON.parse(readFileSync(STATUS_FILE, "utf-8")); } catch {}
  }

  // Fallback to ppm.pid
  const pidFromFile = existsSync(PID_FILE)
    ? parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10)
    : NaN;

  const serverPid = status?.pid ?? (isNaN(pidFromFile) ? null : pidFromFile);
  const tunnelPid = status?.tunnelPid ?? null;

  if (!serverPid && !tunnelPid) {
    console.log("No PPM daemon running.");
    cleanup();
    return;
  }

  // Kill server process
  if (serverPid) killPid(serverPid, "server");

  // Kill tunnel process (independent from server)
  if (tunnelPid) killPid(tunnelPid, "tunnel");

  // Windows fallback: kill orphan cloudflared processes spawned by PPM
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/F", "/IM", "cloudflared.exe"], { stdout: "ignore", stderr: "ignore" });
    } catch {}
  }

  cleanup();
  console.log("PPM stopped.");
}

function cleanup() {
  if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}
