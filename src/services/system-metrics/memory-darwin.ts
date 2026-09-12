/**
 * macOS swap, which is the one memory figure the platform publishes and `node:os`
 * does not.
 *
 * Off Linux every swap field was absent, and the memory page renders an absent
 * field as an em dash — i.e. as the claim "this host's swap cannot be measured".
 * On a Mac it can: `vm.swapusage` is a single sysctl. On the host this was found
 * on it read **8047 MB of 9216 MB in use**, which is the most consequential thing
 * that page could have been saying about the machine and was saying nothing about.
 *
 * `vm_stat` is deliberately not used here. It carries page counts but no swap at
 * all, and the page counts are not needed: `os.freemem()` on darwin agrees with
 * what `top` calls unused (75 MB against PPM's 124 MB on the same host, sampled
 * seconds apart), so the cross-platform figure is already the one Activity
 * Monitor shows. Do not "fix" it against `memory_pressure`, whose free
 * percentage measures what could be reclaimed under duress and read 56% on a
 * machine `top` called 31G used.
 *
 * The per-tick cost was measured rather than assumed, because this runs on every
 * tick: **1.33 ms/call**, against the 1.7 ms `/proc/<pid>/io` already costs per
 * tick on Linux. It stays `spawnSync` because `collectMemory` is synchronous and
 * making the whole memory step async for one number is the larger change.
 */
import type { MemoryMetrics } from "../../types/system-metrics.ts";

type SwapFields = Pick<MemoryMetrics, "swapTotalMB" | "swapUsedMB">;

/** `total = 9216.00M  used = 8047.00M  free = 1169.00M  (encrypted)` */
const SWAP_RE = /total\s*=\s*([\d.]+)([KMGT])?\b[\s\S]*?used\s*=\s*([\d.]+)([KMGT])?\b/i;

const MB_PER_UNIT: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Pure half, so the format can be tested without a Mac.
 *
 * `undefined` rather than zeroes when the text does not parse: a shape this code
 * does not recognise is a host it did not measure, and 0 would be a claim that
 * the machine has no swap.
 */
export function parseSwapUsage(text: string | null | undefined): SwapFields | undefined {
  if (!text) return undefined;
  const m = SWAP_RE.exec(text);
  if (!m) return undefined;

  const toMB = (value: string, unit: string | undefined): number | null => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    // A bare number is bytes. The format normally carries a suffix, but a swap
    // file of zero prints as `0.00M` on some releases and `0` on others, and
    // reading that second form as megabytes would invent 0 MB either way — it
    // is only correct here because the value is zero.
    return unit ? n * (MB_PER_UNIT[unit.toUpperCase()] ?? 1) : n / (1024 * 1024);
  };

  const total = toMB(m[1]!, m[2]);
  const used = toMB(m[3]!, m[4]);
  if (total === null || used === null) return undefined;

  return {
    swapTotalMB: round1(total),
    // Clamped, because a used figure above the total is not a bigger swap, it is
    // a sample taken while the file was being resized.
    swapUsedMB: round1(Math.min(Math.max(used, 0), total)),
  };
}

/**
 * `null` on every platform but darwin, so nothing is spawned where the figure
 * already comes from `/proc/meminfo` or from CIM.
 */
export function readSwapUsage(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const result = Bun.spawnSync(["sysctl", "-n", "vm.swapusage"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (result.exitCode !== 0) return null;
    return new TextDecoder().decode(result.stdout);
  } catch {
    // `Bun.spawn` raises `Executable not found in $PATH` *synchronously* for a
    // missing binary rather than reporting it through an exit code, and
    // `spawnSync` is no different — the same trap `spawn-runner.ts` carries a
    // comment about. A stripped-down host without `sysctl` gets an em dash, not
    // a collector that throws mid-tick.
    return null;
  }
}
