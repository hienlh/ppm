import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

const STATUS_FILE = resolve(homedir(), ".ppm", "status.json");
const PID_FILE = resolve(homedir(), ".ppm", "ppm.pid");

interface DaemonStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  host: string | null;
  shareUrl: string | null;
}

function getDaemonStatus(): DaemonStatus {
  const notRunning: DaemonStatus = { running: false, pid: null, port: null, host: null, shareUrl: null };

  // Try status.json first
  if (existsSync(STATUS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
      const pid = data.pid as number;
      // Check if process is actually alive
      try {
        process.kill(pid, 0); // signal 0 = check existence
        return { running: true, pid, port: data.port, host: data.host, shareUrl: data.shareUrl ?? null };
      } catch {
        return notRunning; // stale status file
      }
    } catch {
      return notRunning;
    }
  }

  // Fallback to ppm.pid
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      process.kill(pid, 0);
      return { running: true, pid, port: null, host: null, shareUrl: null };
    } catch {
      return notRunning;
    }
  }

  return notRunning;
}

export async function showStatus(options: { json?: boolean }) {
  const status = getDaemonStatus();

  if (options.json) {
    console.log(JSON.stringify(status));
    return;
  }

  if (!status.running) {
    console.log("  PPM is not running.");
    return;
  }

  console.log(`\n  PPM daemon is running\n`);
  console.log(`  PID:     ${status.pid}`);
  if (status.port) console.log(`  Local:   http://localhost:${status.port}/`);
  if (status.shareUrl) {
    console.log(`  Share:   ${status.shareUrl}`);
    const qr = await import("qrcode-terminal");
    console.log();
    qr.generate(status.shareUrl, { small: true });
  }
  console.log();
}
