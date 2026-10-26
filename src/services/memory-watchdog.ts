/**
 * Always-on memory watchdog: a few lines in `ppm.log`, so that "why is PPM using so much RAM"
 * has an answer in the log a user already has, without anyone having set `PPM_MEM_DIAG`.
 *
 * Every minute it reads this process's private bytes and those of every process below it
 * (one OS call, ~8 ms on Windows). It writes:
 * - a summary line every 30 minutes — this process, its children by program, the biggest child
 *   branches with the chat session each one serves, the busiest HTTP routes since the last
 *   summary, and the registered gauges (sessions, clients, terminals…). WARN instead of INFO
 *   when private bytes grew by a gigabyte or more since the previous summary;
 * - a WARN the first time private bytes (and, for the server, its children's total) cross each
 *   threshold, with the same detail;
 * - an INFO when a Claude/Codex subprocess starts or exits, with its pid, its session and what
 *   it held at its last reading — the pid in the summary is then traceable to a chat.
 *
 * What it answered on 26/10/2026, after the fact and by hand: the server at 7 GB while its JS
 * heap was 186 MB (a native leak), and 17 Claude subprocesses at ~650 MB each (by design, one
 * per open chat). Both halves are in one summary line now.
 *
 * The detailed per-30-second JSON stays behind `PPM_MEM_DIAG=1` (`memory-diagnostics.ts`).
 */
import { createLogger } from "./logger.ts";
import { readNativeMemory } from "./memory-diagnostics-native.ts";
import { spawnTracker } from "./memory-diagnostics-spawns.ts";
import { diffRequestCounts, requestTracker } from "./memory-diagnostics-requests.ts";
import { descendantsOf, readProcessList } from "./process-tree-memory.ts";
import { heapStats } from "bun:jsc";

const log = createLogger("mem");

const MB = 1024 * 1024;
const WATCH_INTERVAL_MS = 60_000;
const SUMMARY_INTERVAL_MS = 30 * 60_000;
/** Growth between two summaries that turns the summary into a WARN. */
const FAST_GROWTH_MB = 1024;
const SELF_ALERT_MB = [2048, 4096, 8192, 16384, 32768];
const CHILDREN_ALERT_MB = [8192, 16384, 24576, 32768];

export interface ChildBranch {
  pid: number;
  name: string;
  /** The tracker's label for a direct child, when it saw the spawn. */
  label?: string;
  session?: string;
  ageMin?: number;
  /** The child alone. */
  ownMB: number;
  /** The child and everything below it. */
  treeMB: number;
}

export interface TreeSummary {
  count: number;
  privateMB: number;
  byName: Record<string, { n: number; mb: number }>;
  /** Direct children, biggest subtree first. */
  branches: ChildBranch[];
}

/** Read the tree below `rootPid` and fold it by program and by direct child. Undefined when unreadable. */
export async function summarizeDescendants(rootPid: number, limit: number): Promise<TreeSummary | undefined> {
  const list = await readProcessList(rootPid);
  if (!list) return undefined;
  const all = descendantsOf(rootPid, list);
  const byName: TreeSummary["byName"] = {};
  const branches = new Map<number, ChildBranch>();
  let privateMB = 0;
  for (const d of all) {
    privateMB += d.privateMB;
    const n = (byName[d.name] ??= { n: 0, mb: 0 });
    n.n++;
    n.mb += d.privateMB;
    if (d.depth === 1) {
      const tracked = spawnTracker.describe(d.pid);
      if (tracked) tracked.lastPrivateMB = d.privateMB;
      branches.set(d.pid, {
        pid: d.pid, name: d.name, label: tracked?.label, session: tracked?.session,
        ageMin: tracked ? Math.round((Date.now() - tracked.startedAt) / 60_000) : undefined,
        ownMB: d.privateMB, treeMB: 0,
      });
    }
  }
  for (const d of all) {
    const b = branches.get(d.branchPid);
    if (b) b.treeMB += d.privateMB;
  }
  return {
    count: all.length,
    privateMB,
    byName,
    branches: [...branches.values()].sort((a, b) => b.treeMB - a.treeMB).slice(0, limit),
  };
}

const plural = (n: number, mb: number) => `${n > 1 ? `×${n} ` : ""}${mb}MB`;

/** The children half of a log line. Exported for tests. */
export function describeTree(tree: TreeSummary | undefined): string {
  if (!tree) return "children unreadable";
  if (tree.count === 0) return "no children";
  const names = Object.entries(tree.byName)
    .sort((a, b) => b[1].mb - a[1].mb).slice(0, 6)
    .map(([name, v]) => `${name} ${plural(v.n, v.mb)}`).join(", ");
  const biggest = tree.branches.slice(0, 5).map((b) => {
    const who = b.session ? `session=${b.session.slice(0, 8)}` : b.label ?? b.name;
    const own = b.treeMB !== b.ownMB ? ` (own ${b.ownMB}MB)` : "";
    const age = b.ageMin !== undefined ? ` ${b.ageMin}m` : "";
    return `${b.name} pid=${b.pid} ${who}${age} ${b.treeMB}MB${own}`;
  }).join("; ");
  return `children ${tree.count} = ${tree.privateMB}MB [${names}] biggest: ${biggest}`;
}

function describeRequests(top: Record<string, { n: number; mb: number; streamed: number }>, total: number): string {
  const rows = Object.entries(top).map(([k, v]) => `${k} ×${v.n}${v.mb ? ` ${v.mb}MB` : ""}${v.streamed ? ` (${v.streamed} streamed)` : ""}`);
  return `requests ${total}${rows.length ? `: ${rows.join(", ")}` : ""}`;
}

function describeGauges(gauges: Record<string, number | string>): string {
  const rows = Object.entries(gauges).map(([k, v]) => `${k}=${v}`);
  return rows.length ? `gauges ${rows.join(" ")}` : "";
}

export function startMemoryWatchdog(role: string, readGauges: () => Record<string, number | string>): void {
  const startedAt = Date.now();
  const selfAlerted = new Set<number>();
  const childAlerted = new Set<number>();
  // The first summary comes a minute after start: the baseline every later line is read against.
  let lastSummaryAt = Date.now() - SUMMARY_INTERVAL_MS + WATCH_INTERVAL_MS;
  let lastSummaryPrivateMB: number | undefined;
  let lastRequests = requestTracker.read();

  spawnTracker.onLifecycle = (e) => {
    const who = `${e.label} pid=${e.pid}${e.session ? ` session=${e.session}` : ""}`;
    if (e.event === "start") log.info(`${who} started`);
    else log.info(`${who} exited after ${e.ageMin}m${e.lastPrivateMB !== undefined ? `, held ${e.lastPrivateMB}MB at its last reading` : ""}`);
  };

  const tick = async () => {
    try {
      const native = await readNativeMemory();
      const tree = await summarizeDescendants(process.pid, 5);
      const self = native.privateMB;
      const crossedSelf = self === undefined ? [] : SELF_ALERT_MB.filter((t) => self >= t && !selfAlerted.has(t));
      const crossedChildren = role === "server" && tree
        ? CHILDREN_ALERT_MB.filter((t) => tree.privateMB >= t && !childAlerted.has(t))
        : [];
      const summaryDue = Date.now() - lastSummaryAt >= SUMMARY_INTERVAL_MS;
      if (!crossedSelf.length && !crossedChildren.length && !summaryDue) return;

      const heapMB = Math.round(heapStats().heapSize / MB);
      const rssMB = Math.round(process.memoryUsage().rss / MB);
      const upMin = Math.round((Date.now() - startedAt) / 60_000);
      const head = `${role} pid=${process.pid} up=${upMin}m private=${self ?? "?"}MB heap=${heapMB}MB rss=${rssMB}MB handles=${native.handles ?? "?"}`;
      const tail = [describeTree(tree), describeGauges(readGauges())].filter(Boolean).join(" | ");

      // One line per crossing, naming the highest threshold passed since the last tick.
      if (crossedSelf.length) {
        for (const t of crossedSelf) selfAlerted.add(t);
        log.warn(`${role} private bytes crossed ${Math.max(...crossedSelf)}MB (heap ${heapMB}MB, so ~${Math.max(0, (self ?? 0) - heapMB)}MB is native) — ${head} | ${tail}`);
      }
      if (crossedChildren.length) {
        for (const t of crossedChildren) childAlerted.add(t);
        log.warn(`${role} children crossed ${Math.max(...crossedChildren)}MB together — ${head} | ${tail}`);
      }
      if (!summaryDue) return;

      const now = requestTracker.read();
      const requests = diffRequestCounts(lastRequests, now, 6);
      lastRequests = now;
      const minutes = Math.round((Date.now() - lastSummaryAt) / 60_000);
      const growth = self !== undefined && lastSummaryPrivateMB !== undefined ? self - lastSummaryPrivateMB : undefined;
      lastSummaryAt = Date.now();
      if (self !== undefined) lastSummaryPrivateMB = self;
      const growthText = growth === undefined ? "" : ` (${growth >= 0 ? "+" : ""}${growth}MB in ${minutes}m)`;
      const reqText = requests.total ? ` | ${describeRequests(requests.top, requests.total)}` : "";
      const line = `summary ${head}${growthText} | ${tail}${reqText}`;
      if (growth !== undefined && growth >= FAST_GROWTH_MB) log.warn(`${line} — private bytes grew fast`);
      else log.info(line);
    } catch (e) {
      log.debug(`watchdog tick failed: ${(e as Error).message}`);
    }
  };

  setInterval(() => { void tick(); }, WATCH_INTERVAL_MS).unref?.();
}
