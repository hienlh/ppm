/**
 * Ends a process (or its tree) after the guard has already said yes. POSIX reuses the
 * repo's process-tree helpers, whose own `killable()` filter (never init, never
 * ourselves) is a second, independent guard. Pids are validated integers and
 * only ever passed as argv elements or to `process.kill` — never interpolated
 * into a shell string.
 */
import type { KillProcessResult } from "../../types/system-metrics.ts";
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import { collectProcessTree, terminateTree } from "../windows-process-tree.ts";

/** Grace between SIGTERM and SIGKILL on POSIX. */
const GRACE_MS = 3000;

export interface KillExecutorDeps {
  platform: NodeJS.Platform;
  run: Runner;
  signal: (pid: number, sig: NodeJS.Signals | 0) => void;
  collectTree: (pid: number) => number[];
  terminateTree: (pids: number[], graceMs: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export const defaultKillExecutorDeps: KillExecutorDeps = {
  platform: process.platform,
  run: defaultRunner,
  signal: (pid, sig) => { process.kill(pid, sig); },
  collectTree: collectProcessTree,
  terminateTree,
  sleep: (ms) => Bun.sleep(ms),
};

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid PID ${pid}`);
}

/** Throws on executor failure; the route maps that to 500. */
export async function executeKill(
  pid: number,
  tree: boolean,
  deps: KillExecutorDeps = defaultKillExecutorDeps,
): Promise<KillProcessResult> {
  assertPid(pid);

  if (deps.platform === "win32") {
    // Async spawn, never execFileSync: taskkill can block up to its timeout and
    // the event loop must keep serving. A non-zero exit (access denied on an
    // elevated target is common) is reported, never masked by a fallback kill.
    // `taskkill /T` walks the tree inside the OS and reports no member list, so
    // `[pid]` is the only honest value for the tree case.
    const argv = tree ? ["taskkill", "/PID", String(pid), "/T", "/F"] : ["taskkill", "/PID", String(pid), "/F"];
    const r = await deps.run(argv, 5000);
    if (r.code !== 0 || r.timedOut) {
      throw new Error((r.stderr || r.stdout || `taskkill exited ${r.timedOut ? "on timeout" : r.code}`).trim());
    }
    return { pid, tree, method: "taskkill", killed: [pid] };
  }

  if (tree) {
    // Enumerate BEFORE signalling: once the root dies its children reparent to
    // init and the tree can no longer be recovered.
    const pids = deps.collectTree(pid);
    await deps.terminateTree(pids, GRACE_MS);
    return { pid, tree: true, method: "signal", killed: pids };
  }

  deps.signal(pid, "SIGTERM");
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid, deps)) return { pid, tree: false, method: "signal", killed: [pid] };
    await deps.sleep(100);
  }
  try { deps.signal(pid, "SIGKILL"); } catch { /* exited between the check and the kill */ }
  return { pid, tree: false, method: "signal", killed: [pid] };
}

function isAlive(pid: number, deps: KillExecutorDeps): boolean {
  try {
    deps.signal(pid, 0);
    return true;
  } catch {
    return false;
  }
}
