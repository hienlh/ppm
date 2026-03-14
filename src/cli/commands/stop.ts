import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, unlinkSync, existsSync } from "node:fs";

const PID_FILE = resolve(homedir(), ".ppm", "ppm.pid");

export async function stopServer() {
  if (!existsSync(PID_FILE)) {
    console.log("No PPM daemon running (PID file not found).");
    return;
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) {
    console.log("Invalid PID file. Removing it.");
    unlinkSync(PID_FILE);
    return;
  }

  try {
    process.kill(pid);
    unlinkSync(PID_FILE);
    console.log(`PPM daemon stopped (PID: ${pid}).`);
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    if (error.code === "ESRCH") {
      console.log(`Process ${pid} not found. Cleaning up PID file.`);
      unlinkSync(PID_FILE);
    } else {
      console.error(`Failed to stop process ${pid}: ${error.message}`);
    }
  }
}
