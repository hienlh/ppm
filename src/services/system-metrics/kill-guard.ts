/**
 * Decides whether a process may be ended. Pure — the same function fills
 * `ProcessInfo.protected` for the UI and gates the kill route, so the disabled
 * button and the 403 cannot disagree.
 *
 * Names are compared lowercased and extension-free, which is why no literal
 * below carries `.exe`: one list matches Windows, Linux and macOS.
 */
import type { MetricsPlatform } from "../../types/system-metrics.ts";

export interface KillGuardContext {
  platform: MetricsPlatform;
  /** Validated-live PPM infra pids: server, parent/supervisor, edge forwarder,
   *  every PPM-managed cloudflared. */
  protectedPids: ReadonlySet<number>;
  /** pid → ppid for this tick. Built once by the process collector. */
  ppidOf: ReadonlyMap<number, number>;
  /** pid → startedAt, so ancestor walks cannot follow a recycled parent. */
  startedAtOf: ReadonlyMap<number, number>;
}

export interface KillGuardVerdict {
  allowed: boolean;
  reason?: string;
}

/** `taskkill /F` on the RPCSS/DcomLaunch `svchost` triggers CRITICAL_PROCESS_DIED;
 *  `dwm` blanks the Win11 desktop. Task Manager refuses all of these too.
 *  `explorer` is deliberately NOT here — it is killable, as in Task Manager. */
export const WINDOWS_CRITICAL_NAMES: ReadonlySet<string> = new Set([
  "system", "registry", "memory compression", "secure system", "smss", "csrss",
  "wininit", "winlogon", "services", "lsass", "lsaiso", "svchost", "dwm",
]);

/** `sshd` is here because PPM is often driven from a phone against a remote
 *  box: ending it locks the user out of the machine they are managing. */
export const POSIX_CRITICAL_NAMES: ReadonlySet<string> = new Set([
  "launchd", "kernel_task", "systemd", "init", "sshd",
]);

/**
 * A parent cannot have started after its child. Unknown (0) start times are
 * accepted — a missing value must not make a real chain invisible.
 */
function plausibleLink(parentStarted: number | undefined, childStarted: number | undefined): boolean {
  if (!parentStarted || !childStarted) return true;
  return parentStarted <= childStarted;
}

/** True when `target` is a strict ancestor of `pid` along plausible ppid links. */
function isAncestorOf(target: number, pid: number, ctx: KillGuardContext): boolean {
  const visited = new Set<number>([pid]);
  let cur = pid;
  while (true) {
    const parent = ctx.ppidOf.get(cur);
    if (parent === undefined || parent < 0 || visited.has(parent)) return false;
    if (!plausibleLink(ctx.startedAtOf.get(parent), ctx.startedAtOf.get(cur))) return false;
    if (parent === target) return true;
    visited.add(parent);
    cur = parent;
  }
}

/** Every descendant of `root` along plausible ppid links, cycle-safe. */
export function collectDescendants(root: number, ctx: Pick<KillGuardContext, "ppidOf" | "startedAtOf">): Set<number> {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of ctx.ppidOf) {
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out = new Set<number>();
  const queue = [root];
  const visited = new Set<number>([root]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of children.get(cur) ?? []) {
      if (visited.has(child)) continue;
      if (!plausibleLink(ctx.startedAtOf.get(cur), ctx.startedAtOf.get(child))) continue;
      visited.add(child);
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

export function checkKillAllowed(
  target: { pid: number; name: string },
  tree: boolean,
  ctx: KillGuardContext,
): KillGuardVerdict {
  const { pid } = target;
  const name = target.name.toLowerCase();
  const refuse = (reason: string): KillGuardVerdict => ({ allowed: false, reason });

  if (!Number.isInteger(pid) || pid <= 0) return refuse("Invalid PID");
  if (ctx.protectedPids.has(pid)) return refuse(`${target.name} is a PPM process and cannot be ended`);

  if (ctx.platform === "win32") {
    if (pid === 4) return refuse("Cannot kill an OS kernel process");
    if (WINDOWS_CRITICAL_NAMES.has(name)) return refuse(`${target.name} is an OS-critical process`);
  } else {
    if (pid <= 1) return refuse("Cannot kill init");
    if (POSIX_CRITICAL_NAMES.has(name)) return refuse(`${target.name} is an OS-critical process`);
  }

  // Ending an ancestor of the PPM server kills the server while its orphaned
  // grandchildren keep the inheritable listening socket — the zombie-port state.
  for (const protectedPid of ctx.protectedPids) {
    if (isAncestorOf(pid, protectedPid, ctx)) {
      return refuse(`Ending ${target.name} would also end the PPM server`);
    }
  }

  if (tree) {
    const descendants = collectDescendants(pid, ctx);
    for (const protectedPid of ctx.protectedPids) {
      if (descendants.has(protectedPid)) return refuse("Ending this process tree would also end PPM");
    }
  }

  return { allowed: true };
}
