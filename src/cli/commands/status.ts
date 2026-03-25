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
  supervisorPid: number | null;
  supervisorAlive: boolean;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getDaemonStatus(): DaemonStatus {
  const dead: DaemonStatus = {
    running: false, pid: null, port: null, host: null,
    shareUrl: null, tunnelPid: null, tunnelAlive: false,
    supervisorPid: null, supervisorAlive: false,
  };

  if (existsSync(STATUS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
      const pid = data.pid as number;
      const tunnelPid = (data.tunnelPid as number) ?? null;
      const tunnelAlive = tunnelPid ? isAlive(tunnelPid) : false;
      const supervisorPid = (data.supervisorPid as number) ?? null;
      const supervisorAlive = supervisorPid ? isAlive(supervisorPid) : false;
      return {
        running: isAlive(pid),
        pid,
        port: data.port,
        host: data.host,
        shareUrl: data.shareUrl ?? null,
        tunnelPid,
        tunnelAlive,
        supervisorPid,
        supervisorAlive,
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

interface ProcessInfo {
  pid: number;
  command: string;
  args: string;
}

function findSystemProcesses(name: string): ProcessInfo[] {
  try {
    if (process.platform === "win32") {
      // Windows: use wmic to list processes matching name
      const result = Bun.spawnSync(
        ["wmic", "process", "where", `CommandLine like '%${name}%'`, "get", "ProcessId,CommandLine", "/format:csv"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const output = result.stdout.toString().trim();
      if (!output) return [];
      return output.split("\n").slice(1) // skip header
        .map((line) => {
          const parts = line.trim().split(",");
          if (parts.length < 3) return null;
          const pid = parseInt(parts[parts.length - 1]!, 10);
          const cmdLine = parts.slice(1, -1).join(",");
          return { pid, command: name, args: cmdLine };
        })
        .filter((p): p is ProcessInfo => p !== null && !isNaN(p.pid) && p.args.includes(name));
    }
    // macOS/Linux: use pgrep
    const result = Bun.spawnSync(["pgrep", "-afl", name], { stdout: "pipe", stderr: "ignore" });
    const output = result.stdout.toString().trim();
    if (!output) return [];
    return output.split("\n").map((line) => {
      const spaceIdx = line.indexOf(" ");
      const pid = parseInt(line.substring(0, spaceIdx), 10);
      const rest = line.substring(spaceIdx + 1);
      return { pid, command: name, args: rest };
    }).filter((p) => !isNaN(p.pid));
  } catch { return []; }
}

export async function showStatus(options: { json?: boolean; all?: boolean }) {
  const status = getDaemonStatus();

  if (options.all) {
    const ppmProcs = findSystemProcesses("ppm");
    const cfProcs = findSystemProcesses("cloudflared");

    if (options.json) {
      console.log(JSON.stringify({ tracked: status, ppm: ppmProcs, cloudflared: cfProcs }));
      return;
    }

    console.log(`\n  PPM system processes\n`);

    // Tracked daemon
    console.log("  Tracked daemon:");
    if (status.running) {
      console.log(`    Server:  running (PID: ${status.pid})`);
      if (status.port) console.log(`    Local:   http://localhost:${status.port}/`);
    } else {
      console.log("    Server:  not running");
    }
    if (status.tunnelPid) {
      console.log(`    Tunnel:  ${status.tunnelAlive ? "running" : "stopped"} (PID: ${status.tunnelPid})`);
    }
    if (status.shareUrl) console.log(`    Share:   ${status.shareUrl}`);

    // All bun/node processes running PPM server
    const serverProcs = ppmProcs.filter((p) => p.args.includes("ppm") && !p.args.includes("pgrep"));
    if (serverProcs.length > 0) {
      console.log(`\n  PPM-related processes (${serverProcs.length}):`);
      for (const p of serverProcs) console.log(`    PID ${p.pid}  ${p.args}`);
    }

    // All cloudflared processes
    if (cfProcs.length > 0) {
      console.log(`\n  Cloudflared processes (${cfProcs.length}):`);
      for (const p of cfProcs) console.log(`    PID ${p.pid}  ${p.args}`);
    }

    if (serverProcs.length === 0 && cfProcs.length === 0 && !status.running) {
      console.log("\n  No PPM or cloudflared processes found.");
    }

    console.log();
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(status));
    return;
  }

  if (!status.running && !status.tunnelAlive) {
    console.log("  PPM is not running.");
    return;
  }

  console.log(`\n  PPM daemon status\n`);
  if (status.supervisorPid) {
    console.log(`  Supervisor: ${status.supervisorAlive ? "running" : "stopped"} (PID: ${status.supervisorPid})`);
  }
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
