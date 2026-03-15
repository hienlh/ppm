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
  tunnelPid: number | null;
  tunnelAlive: boolean;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getDaemonStatus(): DaemonStatus {
  const dead: DaemonStatus = {
    running: false, pid: null, port: null, host: null,
    shareUrl: null, tunnelPid: null, tunnelAlive: false,
  };

  if (existsSync(STATUS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
      const pid = data.pid as number;
      const tunnelPid = (data.tunnelPid as number) ?? null;
      const tunnelAlive = tunnelPid ? isAlive(tunnelPid) : false;
      return {
        running: isAlive(pid),
        pid,
        port: data.port,
        host: data.host,
        shareUrl: data.shareUrl ?? null,
        tunnelPid,
        tunnelAlive,
      };
    } catch { return dead; }
  }

  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      return { ...dead, running: isAlive(pid), pid };
    } catch { return dead; }
  }

  return dead;
}

export async function showStatus(options: { json?: boolean }) {
  const status = getDaemonStatus();

  if (options.json) {
    console.log(JSON.stringify(status));
    return;
  }

  if (!status.running && !status.tunnelAlive) {
    console.log("  PPM is not running.");
    return;
  }

  console.log(`\n  PPM daemon status\n`);
  console.log(`  Server:  ${status.running ? "running" : "stopped"} (PID: ${status.pid})`);
  if (status.port) console.log(`  Local:   http://localhost:${status.port}/`);
  if (status.tunnelPid) {
    console.log(`  Tunnel:  ${status.tunnelAlive ? "running" : "stopped"} (PID: ${status.tunnelPid})`);
  }
  if (status.shareUrl) {
    console.log(`  Share:   ${status.shareUrl}`);
    const qr = await import("qrcode-terminal");
    console.log();
    qr.generate(status.shareUrl, { small: true });
  }
  console.log();
}
