import { statSync } from "node:fs";

/**
 * Whether a pid `status.json` recorded still names the process that was recorded, rather than one
 * the OS handed the number to later.
 *
 * `status.json` outlives its run, a reboot included, and on Windows the boot time cannot tell the
 * two apart: with Fast Startup (the default on many Windows 10/11 machines) "Shut down" hibernates
 * the kernel, so `os.uptime()` keeps counting across it. What can: a process that really belonged
 * to the recorded run started before the file was last written (the supervisor rewrites it while it
 * runs), and a process that took a dead run's pid started after. Before PPM's watchdog started PPM
 * at every logon, a reused pid meant `ppm start` could tree-kill a stranger, or refuse to start as
 * "already running".
 *
 * Windows reads the start times over FFI (`readProcessList`); elsewhere liveness is all there is
 * (and Linux's uptime does reset at boot, which `leftoverPidsToKill` checks).
 */

/** Grace for clock and file-time granularity: a process started this much after the write still counts. */
const START_GRACE_MS = 2_000;

/** Pure: alive, and (when both times are known) started no later than the record was written. Exported for tests. */
export function isRecordedProcess(alive: boolean, startedAt: number | undefined, recordedAt: number | null): boolean {
  if (!alive) return false;
  if (startedAt === undefined || recordedAt === null) return true;
  return startedAt <= recordedAt + START_GRACE_MS;
}

/** When `file` was last written (ms), or null. */
export function writtenAt(file: string): number | null {
  try { return statSync(file).mtimeMs; } catch { return null; }
}

/**
 * The pids among `pids` that are still the recorded processes. One process-list read for all of
 * them; never throws.
 */
export async function recordedProcesses(pids: readonly number[], recordedAt: number | null): Promise<Set<number>> {
  const out = new Set<number>();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let starts: Map<number, number> | null = null;
  if (process.platform === "win32" && recordedAt !== null) {
    try {
      const { readProcessList } = await import("../process-tree-memory.ts");
      const list = await readProcessList(process.pid);
      if (list) starts = new Map(list.map((p) => [p.pid, p.startedAt]));
    } catch { /* liveness only */ }
  }
  for (const pid of pids) {
    if (isRecordedProcess(alive(pid), starts?.get(pid), starts ? recordedAt : null)) out.add(pid);
  }
  return out;
}
