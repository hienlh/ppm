/**
 * Process-tree utilities shared by supervisor / stop / server.
 *
 * Most of this file is Windows-specific (see below), but the kill/collect
 * helpers are cross-platform: on POSIX the server's children are NOT in their
 * own process group (Bun.spawn does not setsid), so a `kill(-pid)` group kill
 * targets a group that does not exist and silently no-ops. Descendants must be
 * enumerated from `ps` and signalled individually, and the enumeration has to
 * happen BEFORE the parent dies — once it exits, its children reparent to init
 * and the tree is unrecoverable.
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
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { getPpmDir } from "./ppm-dir.ts";

/**
 * Return the PID that owns the LISTENING socket for `port`, or 0 if none /
 * undeterminable. Matches any local bind address (0.0.0.0, 127.0.0.1, [::], …)
 * — the holder may bind a different address than the one we configured.
 */
export function findPortListenerPid(port: number): number {
  if (process.platform !== "win32") {
    // lsof, not pgrep/pkill: on a memory-pressured box `sysmond` can be
    // jetsam-killed, after which pgrep/pkill fail with a misleading error.
    try {
      const out = execFileSync(
        "lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
        { encoding: "utf-8", timeout: 5000 },
      );
      for (const line of out.split("\n")) {
        const pid = parseInt(line.trim(), 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    } catch {}
    return 0;
  }
  try {
    const out = execFileSync("netstat", ["-ano"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    for (const line of out.split("\n")) {
      if (!line.includes("LISTENING")) continue;
      // Columns: Proto  LocalAddress  ForeignAddress  State  PID
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? "";
      if (!local.endsWith(":" + port)) continue;
      const pid = parseInt(cols[cols.length - 1] ?? "", 10);
      if (!isNaN(pid)) return pid;
    }
  } catch {}
  return 0;
}

// ─── /proc readers (Linux) ─────────────────────────────────────────────
// `ps` is NOT guaranteed to exist: it ships in `procps`, which slim Debian
// images (including the one PPM's own test suite runs in) leave out. Every
// caller here swallows the spawn error and reports "no descendants" / "not a
// PPM process", so a missing binary silently disables orphan reaping instead of
// failing loudly. Linux exposes the same data through /proc with no subprocess
// at all, so prefer it and keep `ps` only for macOS.

/** Lowercased argv of `pid`, or null when /proc is unavailable/unreadable. */
function readProcCmdline(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    // NUL-separated argv; join with spaces so substring checks behave like `ps`.
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").join(" ").toLowerCase();
  } catch {
    return null;
  }
}

/** pid → ppid for every visible process, or null when /proc is unavailable. */
function readProcPpidMap(): Map<number, number> | null {
  if (process.platform !== "linux") return null;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  const ppidOf = new Map<number, number>();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf-8");
      // Format: `pid (comm) state ppid ...`. comm can contain spaces AND
      // parentheses, so anchor on the LAST ')' rather than splitting naively.
      const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const ppid = parseInt(rest[1] ?? "", 10); // [0] = state, [1] = ppid
      if (!isNaN(ppid)) ppidOf.set(parseInt(name, 10), ppid);
    } catch {
      // Process exited between readdir and read — normal, skip it.
    }
  }
  return ppidOf.size > 0 ? ppidOf : null;
}

/**
 * Heuristic: does `pid`'s command line look like a PPM-owned process?
 * Used to decide whether reclaiming a port held by an alive process is safe
 * (a stale PPM orphan) vs. an unrelated app we must not kill.
 */
export function isPpmProcess(pid: number): boolean {
  if (process.platform !== "win32") {
    const cmdline = readProcCmdline(pid);
    if (cmdline !== null) {
      return cmdline.includes("__serve__") || cmdline.includes("__supervise__");
    }
    try {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf-8",
        timeout: 5000,
      }).toLowerCase();
      return out.includes("__serve__") || out.includes("__supervise__");
    } catch {
      return false;
    }
  }
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
    );
    const cmd = out.toLowerCase();
    return cmd.includes("ppm") || cmd.includes("__serve__") || cmd.includes("__supervise__");
  } catch {
    return false;
  }
}

interface TrackedProc {
  pid: number;
  /** Win32_Process.CreationDate ticks — identity check against PID reuse */
  ticks: string;
}

const trackedFile = () => resolve(getPpmDir(), "tracked-descendants.json");

// One line per process: "pid|ppid|creationTicks"
const PS_LIST_CMD =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.Ticks)" }';

// Shorter than the caller's 30s poll, so a wedged PowerShell can never outlive
// the interval that spawned it and stack up behind the in-flight guard.
const LIST_TIMEOUT_MS = 20_000;

async function listProcesses(): Promise<Map<number, { ppid: number; ticks: string }>> {
  const map = new Map<number, { ppid: number; ticks: string }>();
  const proc = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", PS_LIST_CMD],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true },
  );
  const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, LIST_TIMEOUT_MS);
  let out: string;
  try {
    out = await new Response(proc.stdout).text();
    await proc.exited;
  } finally {
    clearTimeout(killTimer);
  }
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
    killPids(collectProcessTree(pid), "SIGKILL");
  }
}

/**
 * POSIX: `pid` plus every descendant, parents before children. Windows: `[pid]`
 * (taskkill /T walks the tree itself).
 *
 * Must be called while `pid` is still alive — descendants are found by walking
 * ppid links, and a dead parent's children have already reparented to init.
 */
export function collectProcessTree(pid: number): number[] {
  if (process.platform === "win32") return [pid];

  const childrenOf = new Map<number, number[]>();
  const addEdge = (child: number, parent: number) => {
    const arr = childrenOf.get(parent);
    if (arr) arr.push(child);
    else childrenOf.set(parent, [child]);
  };

  const fromProc = readProcPpidMap();
  if (fromProc) {
    for (const [p, pp] of fromProc) addEdge(p, pp);
  } else {
    try {
      const out = execFileSync("ps", ["-Ao", "pid=,ppid="], {
        encoding: "utf-8",
        timeout: 5000,
      });
      for (const line of out.split("\n")) {
        const [pidStr, ppidStr] = line.trim().split(/\s+/);
        const p = parseInt(pidStr ?? "", 10);
        const pp = parseInt(ppidStr ?? "", 10);
        if (isNaN(p) || isNaN(pp)) continue;
        addEdge(p, pp);
      }
    } catch {
      return [pid];
    }
  }

  // BFS with visited guard — PID reuse can produce bogus parent cycles.
  const visited = new Set<number>([pid]);
  const order = [pid];
  const queue = [pid];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      order.push(child);
      queue.push(child);
    }
  }
  return order;
}

/** Never signal init or ourselves, whatever the caller passes in. */
function killable(pids: number[]): number[] {
  return pids.filter((p) => p > 1 && p !== process.pid);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Signal `pids` deepest-first so a parent cannot respawn a child mid-teardown. */
export function killPids(pids: number[], signal: NodeJS.Signals = "SIGKILL"): void {
  for (const p of killable(pids).reverse()) {
    try { process.kill(p, signal); } catch {}
  }
}

/**
 * Graceful tree teardown: SIGTERM everything, wait up to `graceMs` for the tree
 * to drain, then SIGKILL whatever is left. Callers must pass a tree collected
 * before the root exited (see `collectProcessTree`).
 */
export async function terminateTree(pids: number[], graceMs: number = 2000): Promise<void> {
  const targets = killable(pids);
  if (targets.length === 0) return;

  killPids(targets, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!targets.some(isAlive)) return;
    await Bun.sleep(100);
  }

  killPids(targets, "SIGKILL");
}

/**
 * Snapshot all live descendants of `rootPid` into the tracked file.
 * Previously tracked processes that are still the same process (alive with a
 * matching creation time) are kept even if they have since orphaned out of
 * the tree — that is exactly the case the reaper exists for.
 */
let snapshotInFlight = false;

export async function snapshotServerDescendants(rootPid: number): Promise<void> {
  if (process.platform !== "win32") return;
  // The supervisor fires this from a timer without awaiting. Every concurrent
  // call spawns a PowerShell and builds a full process map, which costs a 32MiB
  // allocator segment that is never returned to the OS — so overlapping calls
  // ratchet the process commit charge up permanently (observed: 19GB committed
  // against 1GB resident). One at a time; a skipped tick is harmless.
  if (snapshotInFlight) return;
  snapshotInFlight = true;
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
  } catch {} finally {
    snapshotInFlight = false;
  }
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
