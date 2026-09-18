/**
 * Delivers ONE signal to a process, or to its whole collected tree — Mission
 * Center's "Send Signal" submenu. Separate from `executeKill` on purpose: a kill
 * escalates SIGTERM to SIGKILL after a grace period, which is right for "end this
 * process" and wrong for every other signal. Asking for SIGSTOP must send SIGSTOP
 * and nothing else.
 *
 * Pids are validated integers passed to `process.kill` or as argv elements —
 * never interpolated into a shell string.
 */
import type { ProcessSignal, SignalProcessResult } from "../../types/system-metrics.ts";
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import { collectProcessTree } from "../windows-process-tree.ts";

/** Windows has no signals. `taskkill` is the only delivery there and it can only
 *  mean "end it", so those two map and the rest are refused with a reason. */
export const WINDOWS_SUPPORTED_SIGNALS: ReadonlySet<ProcessSignal> = new Set<ProcessSignal>(["TERM", "KILL"]);

export interface SignalExecutorDeps {
  platform: NodeJS.Platform;
  run: Runner;
  signal: (pid: number, sig: NodeJS.Signals) => void;
  collectTree: (pid: number) => number[];
}

export const defaultSignalExecutorDeps: SignalExecutorDeps = {
  platform: process.platform,
  run: defaultRunner,
  signal: (pid, sig) => { process.kill(pid, sig); },
  collectTree: collectProcessTree,
};

/** Which signals this host can actually deliver, for the client to build its menu. */
export function supportedSignals(platform: NodeJS.Platform = process.platform): ProcessSignal[] {
  return platform === "win32"
    ? [...WINDOWS_SUPPORTED_SIGNALS]
    : ["TERM", "KILL", "STOP", "CONT", "HUP", "INT", "USR1", "USR2"];
}

/** Throws on executor failure; the handler maps that to 500. */
export async function executeSignal(
  pid: number,
  signal: ProcessSignal,
  tree: boolean,
  deps: SignalExecutorDeps = defaultSignalExecutorDeps,
): Promise<SignalProcessResult> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid PID ${pid}`);

  if (deps.platform === "win32") {
    if (!WINDOWS_SUPPORTED_SIGNALS.has(signal)) {
      throw new Error(`Windows cannot deliver SIG${signal}`);
    }
    const argv = tree
      ? ["taskkill", "/PID", String(pid), "/T", "/F"]
      : ["taskkill", "/PID", String(pid), "/F"];
    const r = await deps.run(argv, 5000);
    if (r.code !== 0 || r.timedOut) {
      throw new Error((r.stderr || r.stdout || `taskkill exited ${r.timedOut ? "on timeout" : r.code}`).trim());
    }
    return { pid, signal, tree, method: "taskkill", signalled: [pid] };
  }

  const posix = `SIG${signal}` as NodeJS.Signals;
  if (!tree) {
    deps.signal(pid, posix);
    return { pid, signal, tree: false, method: "signal", signalled: [pid] };
  }

  // Enumerate BEFORE signalling: SIGKILL on the root reparents its children to
  // init, and the tree can no longer be recovered afterwards. Children are
  // signalled first so a parent cannot fork a replacement mid-sweep.
  const pids = deps.collectTree(pid);
  const signalled: number[] = [];
  for (const target of pids) {
    // A process exiting between the walk and the signal is the normal case here,
    // not a failure of the request — it is simply not in the result.
    try {
      deps.signal(target, posix);
      signalled.push(target);
    } catch { /* already gone */ }
  }
  return { pid, signal, tree: true, method: "signal", signalled };
}
