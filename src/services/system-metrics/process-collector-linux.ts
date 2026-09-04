/**
 * Linux process collector over `/proc` — zero subprocesses for the table and
 * the per-process disk counters. Reuses the repo's `readProcTable()`, which
 * already anchors the `/proc/<pid>/stat` parse on the last `)` so a process
 * name containing spaces cannot shift the fields.
 *
 * Per-process VRAM needs the one `nvidia-smi` call; per-process GPU busy % has
 * no unprivileged source at all, so `gpuPct` stays undefined here.
 */
import { readProcTable, type ProcEntry } from "../proc-table-linux.ts";
import type { ProcessCollection, ProcessCollector, RawProcessRow } from "./process-collector-types.ts";
import { createStickyColumns } from "./process-collector-types.ts";
import { readProcIoBytes, type ProcIoBytes } from "./process-io-linux.ts";
import type { ProcessGpuMemoryCollector } from "./gpu-process-memory-nvidia.ts";

const KB_PER_MB = 1024;

export function procEntriesToRows(entries: readonly ProcEntry[]): RawProcessRow[] {
  const rows: RawProcessRow[] = [];
  for (const e of entries) {
    if (e.pid <= 0) continue;
    rows.push({
      pid: e.pid,
      ppid: e.ppid >= 0 ? e.ppid : -1,
      name: e.comm,
      // Kernel threads have an empty cmdline; the tick falls back to the name.
      command: e.args || null,
      cpuMs: e.cpuMs,
      ramMB: e.rssKB / KB_PER_MB,
      startedAt: Number.isFinite(e.startedAtMs) && e.startedAtMs > 0 ? Math.round(e.startedAtMs) : 0,
    });
  }
  return rows;
}

export interface LinuxProcessCollectorOptions {
  /** Injected so unit tests never touch a real `/proc`. */
  readIo?: (pid: number) => ProcIoBytes | null;
  /** Omitted or null → no per-process VRAM query at all. The production wiring
   *  in `system-metrics-platform.ts` injects it; defaulting to a real collector
   *  here would make an innocent unit test spawn `nvidia-smi`. */
  gpuMemory?: ProcessGpuMemoryCollector | null;
}

export function createLinuxProcessCollector(
  readTable: () => ProcEntry[] | null = readProcTable,
  opts: LinuxProcessCollectorOptions = {},
): ProcessCollector {
  const readIo = opts.readIo ?? readProcIoBytes;
  const gpuMemory = opts.gpuMemory ?? null;
  const observeColumns = createStickyColumns();

  return {
    stop: () => {},
    async collect(): Promise<ProcessCollection> {
      const table = readTable();
      if (!table) {
        return { rows: [], columns: observeColumns({}), warnings: ["Process list unavailable: /proc is not readable"] };
      }
      const gpuMemByPid = (await gpuMemory?.collect()) ?? null;

      let anyIo = false;
      const rows = procEntriesToRows(table).map((r) => {
        // EACCES for another user's process is expected, not an error: that row
        // simply has no disk figures.
        const io = readIo(r.pid);
        if (io) anyIo = true;
        return {
          ...r,
          diskReadBytes: io?.readBytes,
          diskWriteBytes: io?.writeBytes,
          // The query lists only processes holding VRAM, so a missing pid means
          // "measured, holding none".
          gpuMemMB: gpuMemByPid ? gpuMemByPid.get(r.pid) ?? 0 : undefined,
        };
      });

      return {
        rows,
        columns: observeColumns({ disk: anyIo, gpu: gpuMemByPid !== null }),
        warnings: [],
      };
    },
  };
}
