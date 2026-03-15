import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, unlinkSync, existsSync } from "node:fs";

const PID_FILE = resolve(homedir(), ".ppm", "ppm.pid");
const STATUS_FILE = resolve(homedir(), ".ppm", "status.json");

export async function stopServer() {
  let pid: number | null = null;

  // Try status.json first (new format)
  if (existsSync(STATUS_FILE)) {
    try {
      const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
      pid = status.pid;
    } catch {}
  }

  // Fallback to ppm.pid (compat)
  if (!pid && existsSync(PID_FILE)) {
    pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  }

  if (!pid || isNaN(pid)) {
    console.log("No PPM daemon running.");
    // Cleanup stale files
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    return;
  }

  try {
    process.kill(pid);
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    console.log(`PPM daemon stopped (PID: ${pid}).`);
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    if (error.code === "ESRCH") {
      console.log(`Process ${pid} not found. Cleaning up stale files.`);
      if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } else {
      console.error(`Failed to stop process ${pid}: ${error.message}`);
    }
  }
}
