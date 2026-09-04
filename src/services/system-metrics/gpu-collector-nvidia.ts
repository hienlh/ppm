/**
 * NVIDIA GPU utilisation + VRAM via a one-shot `nvidia-smi` per full-tier tick
 * (measured 31 ms, ~60 bytes). No long-lived child: loop mode would keep an
 * Optimus dGPU awake permanently, and the per-spawn leak this repo knows about
 * concerns building a PowerShell process map inside Bun, not a tiny read.
 */
import type { GpuMetrics } from "../../types/system-metrics.ts";
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";

export const NVIDIA_SMI_ARGV = [
  "nvidia-smi",
  "--query-gpu=name,utilization.gpu,memory.used,memory.total",
  "--format=csv,noheader,nounits",
];

const SPAWN_TIMEOUT_MS = 3000;
/** After this many consecutive failures the machine is treated as GPU-less for
 *  the rest of the server's life — a machine does not grow a GPU. */
const MAX_FAILURES = 3;

/** One row per GPU: `name, util, memUsed, memTotal`. `[N/A]` fields become 0
 *  rather than NaN; a row without a name is dropped. */
export function parseNvidiaSmiCsv(text: string): GpuMetrics[] {
  const out: GpuMetrics[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split(",").map((s) => s.trim());
    const name = f[0] ?? "";
    if (!name || f.length < 4) continue;
    out.push({
      name,
      utilPercent: clampPercent(num(f[1])),
      vramUsedMB: Math.max(0, Math.round(num(f[2]))),
      vramTotalMB: Math.max(0, Math.round(num(f[3]))),
    });
  }
  return out;
}

function num(s: string | undefined): number {
  if (s === undefined || /^\[?N\/A\]?$/i.test(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function clampPercent(v: number): number {
  return Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
}

export interface GpuCollector {
  collect(): Promise<GpuMetrics[]>;
  /** True once the collector has given up (no binary / repeated failures). */
  isDisabled(): boolean;
}

export function createNvidiaGpuCollector(run: Runner = defaultRunner): GpuCollector {
  let failures = 0;
  let disabled = false;
  return {
    isDisabled: () => disabled,
    async collect() {
      if (disabled) return [];
      try {
        const r = await run(NVIDIA_SMI_ARGV, SPAWN_TIMEOUT_MS);
        if (r.code !== 0 || r.timedOut) throw new Error(r.stderr || `exit ${r.code}`);
        failures = 0;
        return parseNvidiaSmiCsv(r.stdout);
      } catch {
        // ENOENT (no NVIDIA driver) throws synchronously from the spawn; a
        // present-but-broken nvidia-smi fails a few times, then is given up on.
        if (++failures >= MAX_FAILURES) disabled = true;
        return [];
      }
    },
  };
}
