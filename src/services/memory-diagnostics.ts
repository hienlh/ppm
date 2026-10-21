import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heapStats } from "bun:jsc";
import { getPpmDir } from "./ppm-dir.ts";
import { readNativeMemory } from "./memory-diagnostics-native.ts";
import { spawnTracker } from "./memory-diagnostics-spawns.ts";

/**
 * Opt-in memory monitor for chasing server growth (`PPM_MEM_DIAG=1`).
 *
 * Every interval it appends one JSON line to `<ppm dir>/mem-diag.log` (the supervisor
 * writes `mem-diag-supervisor.log`): RSS, the JS heap, **private bytes** (the commit charge
 * that actually runs a machine out of memory — RSS alone hid a 32 GB leak), kernel handles,
 * the child processes started since the previous line and those still alive, the object
 * types that grew most, a few absolute counts of objects that own native resources, and
 * any gauges registered by long-lived state (session maps, buffered events).
 *
 * How to read it: `bun scripts/mem-diag-report.ts` correlates private-byte growth with
 * spawns and gauges. By hand, the first fork is still private vs heap — private climbing
 * with a flat heap is native memory (child process pipes, allocator segments), which a
 * heap snapshot cannot show; then look at what `spawned` and `gauges` did in the lines
 * where `privateDeltaMB` jumps.
 *
 * Two kinds of one-off lines: a V8 heap snapshot the first time the heap crosses each
 * threshold (diffable in Chrome DevTools → Memory → Comparison), and an `alert` line the
 * first time private bytes cross each threshold, carrying the oldest live children and the
 * all-time spawn totals — the state a later reader can no longer reconstruct.
 */

const gauges = new Map<string, () => number>();

/** Expose a size of long-lived state to the monitor. Cheap to call when the monitor is off. */
export function registerMemoryGauge(name: string, read: () => number): void {
  gauges.set(name, read);
}

const MB = 1024 * 1024;
const SNAPSHOT_THRESHOLDS_MB = [1024, 2048, 4096, 8192];
const PRIVATE_ALERT_THRESHOLDS_MB = [2048, 4096, 8192, 16384, 24576, 32768];
/** Object types that each hold something outside the JS heap. Absolute counts, every line. */
const NATIVE_OWNER_TYPES = ["Subprocess", "FSWatcher", "SQLStatement", "ArrayBuffer", "ReadableStream", "WebSocket", "ServerWebSocket", "Timeout"];
/** ~1 KB a line at 30 s is ~3 MB a day; one rotated copy keeps about two weeks. */
const MAX_LOG_BYTES = 50 * MB;

export interface MemoryDiagnosticsOptions {
  /** Which process this is; anything but `server` gets its own log file. */
  role?: "server" | "supervisor";
}

export function startMemoryDiagnostics(opts: MemoryDiagnosticsOptions = {}): void {
  if (process.env.PPM_MEM_DIAG !== "1") return;
  const role = opts.role ?? "server";
  const intervalMs = Math.max(5_000, Number(process.env.PPM_MEM_DIAG_INTERVAL_MS) || 30_000);
  const dir = getPpmDir();
  const logPath = join(dir, role === "server" ? "mem-diag.log" : `mem-diag-${role}.log`);
  const snapDir = join(dir, "heap-snapshots");
  const taken = new Set<number>();
  const alerted = new Set<number>();
  let lastCounts: Record<string, number> = {};
  let lastPrivateMB: number | undefined;
  const startedAt = Date.now();

  spawnTracker.install();

  const write = (obj: unknown) => {
    try {
      if (statSync(logPath).size > MAX_LOG_BYTES) renameSync(logPath, `${logPath}.1`);
    } catch { /* no file yet */ }
    appendFileSync(logPath, JSON.stringify(obj) + "\n");
  };

  const readGauges = () => {
    const values: Record<string, number | string> = {};
    for (const [name, read] of gauges) {
      try { values[name] = read(); } catch (e) { values[name] = `err: ${(e as Error).message}`; }
    }
    return values;
  };

  const sample = async () => {
    try {
      const mem = process.memoryUsage();
      const stats = heapStats();
      const native = await readNativeMemory();
      const counts = stats.objectTypeCounts as Record<string, number>;
      const grew = Object.entries(counts)
        .map(([type, n]) => [type, n - (lastCounts[type] ?? 0)] as const)
        .filter(([, d]) => d > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12);
      lastCounts = counts;

      const nativeOwners: Record<string, number> = {};
      for (const type of NATIVE_OWNER_TYPES) if (counts[type] !== undefined) nativeOwners[type] = counts[type];

      const spawns = spawnTracker.snapshot();
      const gaugeValues = readGauges();
      const privateDeltaMB = native.privateMB !== undefined && lastPrivateMB !== undefined
        ? native.privateMB - lastPrivateMB
        : undefined;
      if (native.privateMB !== undefined) lastPrivateMB = native.privateMB;

      write({
        t: new Date().toISOString(),
        role,
        pid: process.pid,
        upMin: Math.round((Date.now() - startedAt) / 60_000),
        rssMB: Math.round(mem.rss / MB),
        ...native,
        privateDeltaMB,
        heapMB: Math.round(stats.heapSize / MB),
        heapCapacityMB: Math.round(stats.heapCapacity / MB),
        extraMB: Math.round(stats.extraMemorySize / MB),
        externalMB: Math.round(mem.external / MB),
        arrayBuffersMB: Math.round(mem.arrayBuffers / MB),
        objects: stats.objectCount,
        protectedObjects: stats.protectedObjectCount,
        spawned: spawns.spawned,
        liveChildren: spawns.liveTotal,
        liveByCommand: spawns.live,
        spawnTotal: spawns.total,
        nativeOwners,
        grew: Object.fromEntries(grew),
        gauges: gaugeValues,
      });

      if (native.privateMB !== undefined) {
        for (const threshold of PRIVATE_ALERT_THRESHOLDS_MB) {
          if (native.privateMB < threshold || alerted.has(threshold)) continue;
          alerted.add(threshold);
          write({
            t: new Date().toISOString(),
            role,
            pid: process.pid,
            alert: "private-bytes",
            thresholdMB: threshold,
            privateMB: native.privateMB,
            rssMB: Math.round(mem.rss / MB),
            heapMB: Math.round(stats.heapSize / MB),
            handles: native.handles,
            spawnTotals: spawnTracker.topTotals(40),
            oldestLiveChildren: spawnTracker.oldestLive(40),
            gauges: gaugeValues,
          });
        }
      }

      const heapMB = stats.heapSize / MB;
      for (const threshold of SNAPSHOT_THRESHOLDS_MB) {
        if (heapMB < threshold || taken.has(threshold)) continue;
        taken.add(threshold);
        mkdirSync(snapDir, { recursive: true });
        const file = join(snapDir, `heap-${role}-${threshold}MB-${Date.now()}.heapsnapshot`);
        writeFileSync(file, Bun.generateHeapSnapshot("v8"));
        write({ t: new Date().toISOString(), role, snapshot: file });
      }
    } catch (e) {
      console.warn(`[mem-diag] sample failed: ${(e as Error).message}`);
    }
  };

  console.log(`[mem-diag] sampling every ${intervalMs}ms → ${logPath}`);
  void sample();
  setInterval(() => { void sample(); }, intervalMs).unref?.();
}
