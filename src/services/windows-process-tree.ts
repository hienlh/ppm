/**
 * Windows-only process-tree utilities shared by supervisor / stop / server.
 *
 * The server's listening socket handle is inheritable on Windows, so every
 * descendant the server spawns (Claude SDK node processes, their bash/python
 * children) holds a handle to that socket. If any descendant outlives the
 * server, the port stays in a zombie LISTENING state owned by a dead PID and
 * no new server can ever bind it.
 *
 * `taskkill /T` walks parent links at kill time, so descendants whose parent
 * chain already broke (orphans) escape the tree kill. To catch them, the
 * supervisor periodically snapshots the server's descendant PIDs (plus
 * creation time, to guard against PID reuse) into a file; survivors are
 * reaped whenever the server is stopped or a new supervisor starts.
 */
import { resolve } from "node:path";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { getPpmDir } from "./ppm-dir.ts";

interface TrackedProc {
  pid: number;
  /** Win32_Process.CreationDate ticks — identity check against PID reuse */
  ticks: string;
}

const trackedFile = () => resolve(getPpmDir(), "tracked-descendants.json");

// One line per process: "pid|ppid|creationTicks"
const PS_LIST_CMD =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.Ticks)" }';

async function listProcesses(): Promise<Map<number, { ppid: number; ticks: string }>> {
  const map = new Map<number, { ppid: number; ticks: string }>();
  const proc = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", PS_LIST_CMD],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  for (const line of out.split("\n")) {
    const [pidStr, ppidStr, ticks] = line.trim().split("|");
    const pid = parseInt(pidStr ?? "", 10);
    const ppid = parseInt(ppidStr ?? "", 10);
    if (!isNaN(pid) && !isNaN(ppid)) map.set(pid, { ppid, ticks: ticks ?? "" });
  }
  return map;
}

function readTracked(): TrackedProc[] {
  try {
    if (!existsSync(trackedFile())) return [];
    const data = JSON.parse(readFileSync(trackedFile(), "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Kill an entire process tree rooted at `pid`.
 * On Windows a forced single-PID kill leaves grandchildren alive; they keep
 * the inherited TCP listening socket handle open, leaving the port in a
 * zombie LISTENING state owned by a dead PID. Killing the whole tree releases
 * the socket — the Windows analog of POSIX process-group kill.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // Already dead, or taskkill unavailable — fall back to single-PID kill.
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}

/**
 * Snapshot all live descendants of `rootPid` into the tracked file.
 * Previously tracked processes that are still the same process (alive with a
 * matching creation time) are kept even if they have since orphaned out of
 * the tree — that is exactly the case the reaper exists for.
 */
export async function snapshotServerDescendants(rootPid: number): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const procs = await listProcesses();

    // Keep prior entries only while they still refer to the same process.
    const kept = readTracked().filter((t) => procs.get(t.pid)?.ticks === t.ticks);
    const tracked = new Map<number, TrackedProc>(kept.map((t) => [t.pid, t]));

    const childrenOf = new Map<number, number[]>();
    for (const [pid, info] of procs) {
      const arr = childrenOf.get(info.ppid);
      if (arr) arr.push(pid);
      else childrenOf.set(info.ppid, [pid]);
    }

    // BFS with visited guard — PID reuse can produce bogus parent cycles.
    const visited = new Set<number>([rootPid]);
    const queue = [rootPid];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const child of childrenOf.get(cur) ?? []) {
        if (visited.has(child)) continue;
        visited.add(child);
        tracked.set(child, { pid: child, ticks: procs.get(child)!.ticks });
        queue.push(child);
      }
    }

    writeFileSync(trackedFile(), JSON.stringify([...tracked.values()]));
  } catch {}
}

/**
 * Kill every tracked descendant that is still the same process it was when
 * snapshotted (PID alive + creation time matches). Clears the tracked file.
 * Returns the number of processes reaped.
 */
export async function reapTrackedDescendants(log?: (msg: string) => void): Promise<number> {
  if (process.platform !== "win32") return 0;
  const tracked = readTracked();
  if (tracked.length === 0) return 0;
  let killed = 0;
  try {
    const procs = await listProcesses();
    for (const t of tracked) {
      const info = procs.get(t.pid);
      if (!info || info.ticks !== t.ticks) continue; // dead, or PID was reused
      try {
        execFileSync("taskkill", ["/PID", String(t.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 5000,
          windowsHide: true,
        });
        killed++;
        log?.(`Reaped orphaned server descendant (PID: ${t.pid})`);
      } catch {}
    }
  } catch {}
  try { unlinkSync(trackedFile()); } catch {}
  return killed;
}
