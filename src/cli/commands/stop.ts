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

export async function stopServer() {
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
      const cfPath = resolve(homedir(), ".ppm", "bin", "cloudflared.exe");
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
