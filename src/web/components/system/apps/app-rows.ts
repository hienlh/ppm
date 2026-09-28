/**
 * The Apps page's rows - Mission Center's Apps section.
 *
 * An app's figures are the sum over its whole process SUBTREE, not over the pids
 * the server listed: the server sends only the primary pids (each the root of a
 * subtree), because sending every member would make a browser re-walk the same
 * tree anyway. Chromium-shaped apps are dozens of processes under one root, and
 * a row showing only the root's own CPU reads as permanently idle.
 *
 * Pure and React-free. Relative imports only, so a unit test never reaches a
 * zustand store.
 */
import type { AppInfo, ProcessInfo } from "../../../../types/system-metrics";

export interface AppRow {
  id: string;
  name: string;
  icon: string | null;
  /** The roots the server named; each stands for a subtree. */
  pids: number[];
  /** Every process in those subtrees, the roots included. Ending an app means
   *  ending all of these: the roots alone would leave the helpers running, and
   *  several roots means there is no single tree kill that covers them. */
  memberPids: number[];
  processCount: number;
  cpu: number;
  ramMB: number;
  /** Summed over the members that HAVE a value, and undefined when none does -
   *  so "nothing measurable here" never renders as a confident zero. */
  swapMB?: number;
  diskReadBps?: number;
  diskWriteBps?: number;
  gpuPct?: number;
  gpuMemMB?: number;
}

/** pid to its direct children, built once per tick rather than per app. */
export function childIndex(processes: readonly ProcessInfo[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const p of processes) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  return children;
}

/**
 * Every pid in the subtrees rooted at `roots`, deduplicated.
 *
 * The `seen` set is not only for shared descendants: a `/proc` walk can observe a
 * process being reparented and produce a parent chain that loops, and without the
 * guard this recurses until the stack goes.
 */
export function subtreePids(roots: readonly number[], children: Map<number, number[]>): number[] {
  const seen = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return [...seen];
}

/** Undefined only when NO member measured the figure at all. */
function sumOptional(values: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v === undefined) continue;
    any = true;
    total += v;
  }
  return any ? total : undefined;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * One row per app that still has a live process. An app whose every process
 * exited between the collector and the frame is dropped rather than shown as a
 * zero row - it is not running any more.
 */
export function buildAppRows(apps: readonly AppInfo[], processes: readonly ProcessInfo[]): AppRow[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const children = childIndex(processes);
  const rows: AppRow[] = [];

  for (const app of apps) {
    const members = subtreePids(app.pids, children)
      .map((pid) => byPid.get(pid))
      .filter((p): p is ProcessInfo => p !== undefined);
    if (members.length === 0) continue;

    rows.push({
      id: app.id,
      name: app.name,
      icon: app.icon,
      pids: app.pids,
      memberPids: members.map((p) => p.pid),
      processCount: members.length,
      cpu: round1(members.reduce((sum, p) => sum + p.cpu, 0)),
      ramMB: round1(members.reduce((sum, p) => sum + p.ramMB, 0)),
      swapMB: sumOptional(members.map((p) => p.swapMB)),
      diskReadBps: sumOptional(members.map((p) => p.diskReadBps)),
      diskWriteBps: sumOptional(members.map((p) => p.diskWriteBps)),
      // Engine busy can genuinely exceed 100 summed across processes sharing a
      // GPU, which is the same clamp the server applies to a process group.
      gpuPct: clampPercent(sumOptional(members.map((p) => p.gpuPct))),
      gpuMemMB: sumOptional(members.map((p) => p.gpuMemMB)),
    });
  }
  return rows;
}

function clampPercent(value: number | undefined): number | undefined {
  return value === undefined ? undefined : round1(Math.min(100, Math.max(0, value)));
}

export type AppSortKey = "name" | "cpu" | "ram";

/** Busiest first is what a task manager is for; name is the tiebreaker so the
 *  order does not churn between ticks when several apps sit at 0%. */
export function sortAppRows(rows: readonly AppRow[], key: AppSortKey, dir: "asc" | "desc"): AppRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * a.name.localeCompare(b.name);
    const diff = key === "cpu" ? a.cpu - b.cpu : a.ramMB - b.ramMB;
    return diff !== 0 ? sign * diff : a.name.localeCompare(b.name);
  });
}

/** Substring match over the app's name, as the toolbar's search box needs it. */
export function filterAppRows(rows: readonly AppRow[], query: string): AppRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(needle));
}
