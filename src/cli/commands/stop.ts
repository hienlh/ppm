import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";

const PPM_DIR = process.env.PPM_HOME || resolve(homedir(), ".ppm");
const PID_FILE = resolve(PPM_DIR, "ppm.pid");
const STATUS_FILE = resolve(PPM_DIR, "status.json");
const CMD_FILE = resolve(PPM_DIR, ".supervisor-cmd");

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

export async function stopServer(options?: { all?: boolean; kill?: boolean }) {
  if (options?.all) {
    console.log("  Stopping all PPM and cloudflared processes...\n");
    const cfKilled = killAllByName("cloudflared");
    let killed = 0;
    if (existsSync(STATUS_FILE)) {
      try {
        const data = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
        // Kill supervisor first (cascades to server + tunnel children)
        if (data.supervisorPid) { killPid(data.supervisorPid, "supervisor"); killed++; }
        if (data.pid) { killPid(data.pid, "server"); killed++; }
        if (data.tunnelPid) { killPid(data.tunnelPid, "tunnel"); killed++; }
      } catch {}
    }
    if (existsSync(PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (!isNaN(pid)) { killPid(pid, "supervisor/server (pidfile)"); killed++; }
      } catch {}
    }
    cleanup();
    console.log(`\n  Done. Killed ${cfKilled} cloudflared + ${killed} PPM process(es).`);
    return;
  }

  // Full shutdown: --kill flag or `ppm down`
  if (options?.kill) {
    return hardStop();
  }

  // Default: soft stop — kill server only, supervisor stays alive
  return softStopCmd();
}

/** Soft stop: write command file + signal supervisor → kills server only */
async function softStopCmd() {
  let status: Record<string, unknown> | null = null;
  if (existsSync(STATUS_FILE)) {
    try { status = JSON.parse(readFileSync(STATUS_FILE, "utf-8")); } catch {}
  }

  const supervisorPid = (status?.supervisorPid as number) ?? null;

  if (!supervisorPid) {
    // No supervisor — fall back to hard stop (legacy)
    return hardStop();
  }

  // Check if supervisor is alive
  try { process.kill(supervisorPid, 0); } catch {
    console.log("Supervisor not running. Cleaning up.");
    cleanup();
    return;
  }

  // Already stopped?
  if ((status?.state as string) === "stopped") {
    console.log("PPM server is already stopped. Supervisor still alive.");
    console.log("Use 'ppm stop --kill' or 'ppm down' to fully shut down.");
    return;
  }

  // Write soft stop command file + signal supervisor (Windows: polling picks it up)
  writeFileSync(CMD_FILE, JSON.stringify({ action: "soft_stop" }));
  if (process.platform !== "win32") {
    try { process.kill(supervisorPid, "SIGUSR2"); } catch (e) {
      console.error(`  Failed to signal supervisor: ${e}`);
      return;
    }
  }

  // Wait for state to change to "stopped" in status.json
  const start = Date.now();
  while (Date.now() - start < 5000) {
    await Bun.sleep(500);
    try {
      const data = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
      if (data.state === "stopped") {
        console.log("PPM server stopped. Supervisor still alive (Cloud WS + tunnel).");
        console.log("Use 'ppm start' to restart or 'ppm stop --kill' to fully shut down.");
        return;
      }
    } catch {}
  }
  console.log("PPM server stop requested.");
}

/** Hard stop: SIGTERM supervisor → everything dies (current behavior) */
async function hardStop() {
  let status: { pid?: number; tunnelPid?: number; supervisorPid?: number } | null = null;

  if (existsSync(STATUS_FILE)) {
    try { status = JSON.parse(readFileSync(STATUS_FILE, "utf-8")); } catch {}
  }

  const pidFromFile = existsSync(PID_FILE)
    ? parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10)
    : NaN;

  const supervisorPid = status?.supervisorPid ?? null;
  const serverPid = status?.pid ?? null;
  const tunnelPid = status?.tunnelPid ?? null;
  const fallbackPid = isNaN(pidFromFile) ? null : pidFromFile;

  if (!supervisorPid && !serverPid && !tunnelPid && !fallbackPid) {
    console.log("No PPM daemon running.");
    cleanup();
    return;
  }

  // Kill supervisor first — its SIGTERM handler kills server + tunnel children
  if (supervisorPid) {
    killPid(supervisorPid, "supervisor");
    await Bun.sleep(2000);
  } else if (fallbackPid) {
    killPid(fallbackPid, "supervisor/server (pidfile)");
    await Bun.sleep(1000);
  }

  // Kill remaining children if supervisor didn't clean them up
  if (serverPid) {
    try { process.kill(serverPid, 0); killPid(serverPid, "server"); } catch {}
  }
  if (tunnelPid) {
    try { process.kill(tunnelPid, 0); killPid(tunnelPid, "tunnel"); } catch {}
  }

  // Windows fallback: kill orphan cloudflared processes
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
