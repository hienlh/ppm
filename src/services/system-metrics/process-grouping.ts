/**
 * App grouping: roll every process up to its nearest ancestor below an OS
 * "shell/service boundary", so Chrome is one row with 40 children and a
 * terminal is one row with its shells. Exe-name grouping survives only as the
 * bucket for orphans — it would merge every unrelated `node` on the machine
 * into one row, which is worse than Task Manager.
 */
import type { MetricsPlatform, ProcessGroup, ProcessInfo } from "../../types/system-metrics.ts";

/** Names are extension-free per the contract, so one literal matches every OS. */
const WIN32_BOUNDARY_NAMES: ReadonlySet<string> = new Set([
  "services", "svchost", "explorer", "wininit", "winlogon", "csrss", "userinit", "smss",
]);
const POSIX_BOUNDARY_NAMES: ReadonlySet<string> = new Set(["launchd", "systemd", "init"]);

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The optional per-process columns, which roll up by summation. */
type OptionalMetric = "diskReadBps" | "diskWriteBps" | "gpuPct" | "gpuMemMB" | "netInBps" | "netOutBps";

/**
 * Sum over the members that HAVE a value; `undefined` when none does, so a
 * group on a host that cannot measure a column stays "—" instead of claiming a
 * confident 0. A member without a value contributes nothing rather than
 * suppressing its siblings' figures — on Linux that is the common case (an
 * access-denied `/proc/<pid>/io` next to readable ones).
 */
function sumOptional(procs: readonly ProcessInfo[], field: OptionalMetric): number | undefined {
  let total = 0;
  let measured = false;
  for (const p of procs) {
    const v = p[field];
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      measured = true;
    }
  }
  if (!measured) return undefined;
  // A group's engine busy is still a share of one GPU, so it cannot exceed 100 %.
  return round1(field === "gpuPct" ? Math.min(100, total) : total);
}

function isBoundary(p: ProcessInfo, platform: MetricsPlatform): boolean {
  const name = p.name.toLowerCase();
  if (platform === "win32") return p.pid === 0 || p.pid === 4 || WIN32_BOUNDARY_NAMES.has(name);
  return p.pid <= 1 || POSIX_BOUNDARY_NAMES.has(name);
}

/**
 * Climb `ppid` until the parent is absent, is a boundary, or started AFTER the
 * child (Windows never clears a dead parent's ppid, so a recycled pid would
 * otherwise adopt an unrelated subtree). Returns the chain from `p` upward.
 */
function ancestorChain(p: ProcessInfo, byPid: ReadonlyMap<number, ProcessInfo>, platform: MetricsPlatform): ProcessInfo[] {
  const chain = [p];
  const visited = new Set<number>([p.pid]);
  let cur = p;
  while (true) {
    const parent = byPid.get(cur.ppid);
    if (!parent || visited.has(parent.pid) || isBoundary(parent, platform)) break;
    if (parent.startedAt && cur.startedAt && parent.startedAt > cur.startedAt) break;
    visited.add(parent.pid);
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

/**
 * The PPM subtree always splits out of whatever shell chain launched it: on a
 * dev host that chain is explorer → WindowsTerminal → bun → server, and without
 * this rule PPM would roll up under "WindowsTerminal" and hand the UI a tree-kill
 * button whose blast radius includes the server. The topmost PPM root in the
 * chain wins so supervisor + server + children form ONE group.
 */
function resolveRoot(chain: ProcessInfo[], ppmRoots: ReadonlySet<number>): ProcessInfo {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (ppmRoots.has(chain[i]!.pid)) return chain[i]!;
  }
  return chain[chain.length - 1]!;
}

/**
 * @param ppmRoots  PPM's own roots (server + supervisor/parent): grouping boundaries.
 * @param selfPid   This server's pid. Two PPM instances can share a machine (dev
 *                  beside prod), so a PPM group is labelled by which one it is.
 */
export function groupProcesses(
  procs: readonly ProcessInfo[],
  platform: MetricsPlatform,
  ppmRoots: ReadonlySet<number> = new Set(),
  selfPid: number = -1,
): ProcessGroup[] {
  const byPid = new Map<number, ProcessInfo>();
  for (const p of procs) byPid.set(p.pid, p);

  const members = new Map<string, { label: string; rootPid: number | null; procs: ProcessInfo[] }>();
  for (const p of procs) {
    let key: string;
    let label: string;
    let rootPid: number | null;
    if (p.ppid === -1) {
      key = `exe:${p.name.toLowerCase()}`;
      label = p.name;
      rootPid = null;
    } else {
      const root = resolveRoot(ancestorChain(p, byPid, platform), ppmRoots);
      key = `root:${root.pid}`;
      label = ppmRoots.has(root.pid) ? `PPM (pid ${root.pid})` : root.name;
      rootPid = root.pid;
    }
    const g = members.get(key);
    if (g) g.procs.push(p);
    else members.set(key, { label, rootPid, procs: [p] });
  }

  const groups: ProcessGroup[] = [];
  for (const [key, g] of members) {
    if (g.rootPid !== null && ppmRoots.has(g.rootPid) && g.procs.some((p) => p.pid === selfPid)) {
      g.label = "PPM (this server)";
    }
    g.procs.sort((a, b) => b.cpu - a.cpu || b.ramMB - a.ramMB || a.pid - b.pid);
    groups.push({
      key,
      label: g.label,
      rootPid: g.rootPid,
      cpu: round1(g.procs.reduce((s, p) => s + p.cpu, 0)),
      ramMB: round1(g.procs.reduce((s, p) => s + p.ramMB, 0)),
      count: g.procs.length,
      ppm: g.procs.some((p) => p.ppm),
      pids: g.procs.map((p) => p.pid),
      diskReadBps: sumOptional(g.procs, "diskReadBps"),
      diskWriteBps: sumOptional(g.procs, "diskWriteBps"),
      gpuPct: sumOptional(g.procs, "gpuPct"),
      gpuMemMB: sumOptional(g.procs, "gpuMemMB"),
      netInBps: sumOptional(g.procs, "netInBps"),
      netOutBps: sumOptional(g.procs, "netOutBps"),
    });
  }
  groups.sort((a, b) => b.cpu - a.cpu || b.ramMB - a.ramMB || a.label.localeCompare(b.label));
  return groups;
}
