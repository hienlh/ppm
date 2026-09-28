/**
 * Linux process collector over `/proc` — zero subprocesses for the table and
 * the per-process disk counters. Reuses the repo's `readProcTable()`, which
 * already anchors the `/proc/<pid>/stat` parse on the last `)` so a process
 * name containing spaces cannot shift the fields.
 *
 * Per-process VRAM needs the one `nvidia-smi` call. Per-process GPU busy % comes
 * from DRM fdinfo where the driver publishes it (Intel, AMD) — the proprietary
 * NVIDIA driver publishes neither, so an NVIDIA-only host still fills memory
 * alone.
 */
import { readProcTable, type ProcEntry } from "../proc-table-linux.ts";
import type { ProcessCollection, ProcessCollector, RawProcessRow } from "./process-collector-types.ts";
import { createStickyColumns } from "./process-collector-types.ts";
import { readProcIoBytes, type ProcIoBytes } from "./process-io-linux.ts";
import { readProcSwapMB } from "./process-swap-linux.ts";
import { realLinuxFs } from "./linux-fs.ts";
import { serviceKeyFromCgroup } from "../system-services/app-cgroup-linux.ts";
import type { ProcessGpuMemoryCollector } from "./gpu-process-memory-nvidia.ts";
import type { DrmGpuCollector } from "./gpu-fdinfo-linux.ts";

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
  /** `VmSwap` for one pid, MB. Null = gone or unreadable. */
  readSwap?: (pid: number) => number | null;
  /** `/proc/<pid>/cgroup` for one pid, used only to name its systemd unit. */
  readCgroup?: (pid: number) => string | null;
  /** Whose `systemctl --user` the Services page is reading. Defaults to this
   *  process's own uid. */
  selfUid?: number;
  /** Omitted or null → no per-process VRAM query at all. The production wiring
   *  in `system-metrics-platform.ts` injects it; defaulting to a real collector
   *  here would make an innocent unit test spawn `nvidia-smi`. */
  gpuMemory?: ProcessGpuMemoryCollector | null;
  /** Shared with the whole-GPU collector: it memoises one `/proc` walk per tick,
   *  so whichever of the two asks first pays for it and both see the same numbers. */
  drm?: DrmGpuCollector | null;
}

export function createLinuxProcessCollector(
  readTable: () => ProcEntry[] | null = readProcTable,
  opts: LinuxProcessCollectorOptions = {},
): ProcessCollector {
  const readIo = opts.readIo ?? readProcIoBytes;
  const readSwap = opts.readSwap ?? readProcSwapMB;
  // The Apps page reads the same file under a DIFFERENT rule (it wants the
  // outermost app unit, this wants the innermost unit of any kind), so the two
  // cannot share one read without one of them getting the wrong answer. 1.3 ms
  // for 561 pids, measured on this host.
  const readCgroup = opts.readCgroup ?? ((pid: number) => realLinuxFs.read(`/proc/${pid}/cgroup`));
  // Which user manager is "ours" — a unit of another uid is not on the Services
  // page at all, so its processes must not land on our same-named row.
  const selfUid = opts.selfUid ?? process.getuid?.() ?? 0;
  const gpuMemory = opts.gpuMemory ?? null;
  const drm = opts.drm ?? null;
  const observeColumns = createStickyColumns();

  return {
    stop: () => {},
    async collect(): Promise<ProcessCollection> {
      const table = readTable();
      if (!table) {
        return { rows: [], columns: observeColumns({}), warnings: ["Process list unavailable: /proc is not readable"] };
      }
      const gpuMemByPid = (await gpuMemory?.collect()) ?? null;
      const drmByPid = drm?.usage().perProcess ?? null;

      let anyIo = false;
      let anySwap = false;
      const rows = procEntriesToRows(table).map((r) => {
        // EACCES for another user's process is expected, not an error: that row
        // simply has no disk figures.
        const io = readIo(r.pid);
        if (io) anyIo = true;
        // Both sources list only the processes actually using the GPU, so a
        // missing pid means "measured, holding none" — not "unknown".
        const drmRow = drmByPid?.get(r.pid);
        const nvidiaMem = gpuMemByPid ? gpuMemByPid.get(r.pid) ?? 0 : undefined;
        const drmMem = drmByPid ? (drmRow ? drmRow.vramMB + drmRow.sharedMB : 0) : undefined;
        // A process that exited between the table read and now has neither; both
        // stay absent for that row rather than being reported as zero.
        const swapMB = readSwap(r.pid);
        if (swapMB !== null) anySwap = true;
        const unitKey = serviceKeyFromCgroup(readCgroup(r.pid) ?? "", selfUid);
        return {
          ...r,
          ...(swapMB === null ? {} : { swapMB }),
          ...(unitKey === null ? {} : { unitKey }),
          diskReadBytes: io?.readBytes,
          diskWriteBytes: io?.writeBytes,
          ...(drmByPid ? { gpuPct: drmRow?.gpuPct ?? 0 } : {}),
          gpuMemMB: sumDefined(nvidiaMem, drmMem),
        };
      });

      return {
        rows,
        columns: observeColumns({
          disk: anyIo,
          gpu: gpuMemByPid !== null || drmByPid !== null,
          swap: anySwap,
        }),
        warnings: [],
      };
    },
  };
}

/** Undefined only when NEITHER source measured anything — a host with one of the
 *  two must not report "unknown" for a figure it really does have. */
function sumDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return round1((a ?? 0) + (b ?? 0));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
