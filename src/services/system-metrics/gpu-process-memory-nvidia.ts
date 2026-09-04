/**
 * Per-process VRAM on NVIDIA via one `nvidia-smi --query-compute-apps` per
 * full-tier tick (same one-shot shape and give-up rule as the whole-GPU
 * collector next door).
 *
 * There is deliberately no per-process utilisation here: NVML exposes
 * per-process SM utilisation only through accounting mode / MIG, which is off
 * on consumer cards, so `gpuPct` stays undefined on Linux and only the memory
 * column is filled.
 */
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";

export const NVIDIA_COMPUTE_APPS_ARGV = [
  "nvidia-smi",
  "--query-compute-apps=pid,used_memory",
  "--format=csv,noheader,nounits",
];

const SPAWN_TIMEOUT_MS = 3000;
/** A machine does not grow a GPU: after this many failures, stop asking. */
const MAX_FAILURES = 3;

/** `pid, usedMB` per row. A pid appearing twice (two GPUs) is summed. */
export function parseComputeAppsCsv(text: string): Map<number, number> {
  const byPid = new Map<number, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split(",").map((s) => s.trim());
    const pid = Number(f[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // "[N/A]" / "[Not Supported]" appear on some drivers: the pid is real but
    // the figure is not, so the row contributes 0 rather than NaN.
    const mb = /^\d+(\.\d+)?$/.test(f[1] ?? "") ? Number(f[1]) : 0;
    byPid.set(pid, (byPid.get(pid) ?? 0) + Math.max(0, Math.round(mb * 10) / 10));
  }
  return byPid;
}

export interface ProcessGpuMemoryCollector {
  /** Null when the query is unavailable (no binary, repeated failures) — the
   *  caller then leaves `gpuMemMB` undefined instead of publishing zeros. */
  collect(): Promise<Map<number, number> | null>;
  isDisabled(): boolean;
}

export function createNvidiaProcessMemoryCollector(run: Runner = defaultRunner): ProcessGpuMemoryCollector {
  let failures = 0;
  let disabled = false;
  return {
    isDisabled: () => disabled,
    async collect() {
      if (disabled) return null;
      try {
        const r = await run(NVIDIA_COMPUTE_APPS_ARGV, SPAWN_TIMEOUT_MS);
        if (r.code !== 0 || r.timedOut) throw new Error(r.stderr || `exit ${r.code}`);
        failures = 0;
        return parseComputeAppsCsv(r.stdout);
      } catch {
        if (++failures >= MAX_FAILURES) disabled = true;
        return null;
      }
    },
  };
}
