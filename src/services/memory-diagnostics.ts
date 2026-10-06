import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heapStats } from "bun:jsc";
import { getPpmDir } from "./ppm-dir.ts";

/**
 * Opt-in memory monitor for chasing server growth (`PPM_MEM_DIAG=1`).
 *
 * Every interval it appends one JSON line to `<ppm dir>/mem-diag.log`: RSS, the JS heap,
 * the object types that grew most since the previous sample, and any gauges registered by
 * long-lived state (session maps, buffered events). Comparing RSS against `heapSize` is the
 * first fork in the investigation — RSS climbing with a flat heap is native memory (child
 * process pipes, Bun internals), which a heap snapshot cannot show.
 *
 * A V8-format heap snapshot is written the first time the heap crosses each threshold, so
 * two snapshots from the same run can be diffed in Chrome DevTools (Memory → Comparison).
 */

const gauges = new Map<string, () => number>();

/** Expose a size of long-lived state to the monitor. Cheap to call when the monitor is off. */
export function registerMemoryGauge(name: string, read: () => number): void {
  gauges.set(name, read);
}

const MB = 1024 * 1024;
const SNAPSHOT_THRESHOLDS_MB = [1024, 2048, 4096, 8192];

export function startMemoryDiagnostics(): void {
  if (process.env.PPM_MEM_DIAG !== "1") return;
  const intervalMs = Math.max(5_000, Number(process.env.PPM_MEM_DIAG_INTERVAL_MS) || 30_000);
  const dir = getPpmDir();
  const logPath = join(dir, "mem-diag.log");
  const snapDir = join(dir, "heap-snapshots");
  const taken = new Set<number>();
  let lastCounts: Record<string, number> = {};
  const startedAt = Date.now();

  const sample = () => {
    try {
      const mem = process.memoryUsage();
      const stats = heapStats();
      const counts = stats.objectTypeCounts as Record<string, number>;
      const grew = Object.entries(counts)
        .map(([type, n]) => [type, n - (lastCounts[type] ?? 0)] as const)
        .filter(([, d]) => d > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12);
      lastCounts = counts;

      const gaugeValues: Record<string, number | string> = {};
      for (const [name, read] of gauges) {
        try { gaugeValues[name] = read(); } catch (e) { gaugeValues[name] = `err: ${(e as Error).message}`; }
      }

      const line = {
        t: new Date().toISOString(),
        upMin: Math.round((Date.now() - startedAt) / 60_000),
        rssMB: Math.round(mem.rss / MB),
        heapMB: Math.round(stats.heapSize / MB),
        externalMB: Math.round(mem.external / MB),
        arrayBuffersMB: Math.round(mem.arrayBuffers / MB),
        objects: stats.objectCount,
        grew: Object.fromEntries(grew),
        gauges: gaugeValues,
      };
      appendFileSync(logPath, JSON.stringify(line) + "\n");

      const heapMB = stats.heapSize / MB;
      for (const threshold of SNAPSHOT_THRESHOLDS_MB) {
        if (heapMB < threshold || taken.has(threshold)) continue;
        taken.add(threshold);
        mkdirSync(snapDir, { recursive: true });
        const file = join(snapDir, `heap-${threshold}MB-${Date.now()}.heapsnapshot`);
        writeFileSync(file, Bun.generateHeapSnapshot("v8"));
        appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), snapshot: file }) + "\n");
      }
    } catch (e) {
      console.warn(`[mem-diag] sample failed: ${(e as Error).message}`);
    }
  };

  console.log(`[mem-diag] sampling every ${intervalMs}ms → ${logPath}`);
  sample();
  setInterval(sample, intervalMs).unref?.();
}
