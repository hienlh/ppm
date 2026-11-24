/**
 * How much memory PPM's Chrome holds, for the window's status line. Chrome names its own
 * processes (`SystemInfo.getProcessInfo`), so no process tree is walked and nothing is spawned
 * per reading — a PowerShell per tick would itself leak commit on Windows (CLAUDE.md). Windows
 * reads each process's private bytes (the figure that runs a machine out of memory), Linux its
 * resident set; elsewhere the line shows no RAM figure.
 */
import { readFileSync } from "node:fs";
import type { CdpConnection } from "./cdp-connection.ts";
import { readProcessPrivateMB } from "../memory-diagnostics-native.ts";

async function processMB(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") return readProcessPrivateMB(pid);
  if (process.platform === "linux") {
    try {
      const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
      return kb ? Number(kb) / 1024 : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Total MB over every Chrome process, or null when it cannot be measured here. */
export async function chromeMemoryMB(cdp: CdpConnection, browserPid: number): Promise<number | null> {
  let pids: number[] = [browserPid];
  try {
    const info = await cdp.send<{ processInfo: { id: number }[] }>("SystemInfo.getProcessInfo");
    pids = [browserPid, ...info.processInfo.map((p) => p.id).filter((id) => id !== browserPid)];
  } catch {}
  let total = 0;
  let measured = false;
  for (const pid of pids) {
    const mb = await processMB(pid);
    if (mb !== undefined) {
      total += mb;
      measured = true;
    }
  }
  return measured ? Math.round(total) : null;
}
