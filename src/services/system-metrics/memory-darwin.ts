/**
 * macOS memory as Activity Monitor counts it, from the kernel's own page counts
 * (`host_statistics64`, the numbers `vm_stat` prints) and `vm.swapusage`, both
 * read over FFI so neither tier spawns anything for them.
 *
 * The figure this replaces was wrong in a way that looked right. `os.freemem()`
 * on darwin is the count of *free pages* only — 66 MB on a 32 GB M1 Max — so
 * "used" came out at 31.9 GB, 99.7 %, a status bar permanently red, while
 * Activity Monitor on the same machine said 27.1 GB. It agreed with `top`'s
 * "used", which is the reason it survived: `top` counts file cache as used and
 * Activity Monitor does not. Linux draws the same line (`MemAvailable`: cache the
 * kernel can take back is not "in use"), so this is also the Linux meaning.
 *
 *   used      = App (anonymous − purgeable) + Wired + Compressed   Activity Monitor's "Memory Used"
 *   cached    = file-backed + purgeable                            its "Cached Files"
 *   free      = free pages
 *   available = cached + free                                      what an app can get without
 *                                                                  compressing or swapping anything
 *
 * The three parts add up to about the USABLE memory, not the physical total:
 * 0.86 GB of this host's 32 GB (`hw.memsize − hw.memsize_usable`) is reserved by
 * the firmware and counted as a page in no state. It is in none of the figures,
 * rather than being called free or in use — which is also why `available` is not
 * `total − used` here — and the headline total stays the physical size, which is
 * what Activity Monitor calls "Physical Memory".
 *
 * Do not "fix" any of this against `memory_pressure`: its free percentage
 * measures what could be reclaimed under duress and read 48 % on a machine
 * using 27 of 32 GB.
 *
 * The `sysctl -n vm.swapusage` parser below is kept as the fallback for a host
 * where libSystem could not be opened, so swap never regresses to an em dash.
 */
import type { MemoryMetrics } from "../../types/system-metrics.ts";
import type { MemoryDeviceInfo, MemoryInfo } from "../../types/system-hardware.ts";
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import { darwinKernel, parseXswUsage, type DarwinKernel, type SwapUsage, type VmStatistics64 } from "./darwin-ffi.ts";

type SwapFields = Pick<MemoryMetrics, "swapTotalMB" | "swapUsedMB">;

const MB = 1024 * 1024;

/** One tick's raw memory figures. */
export interface DarwinMemorySample {
  /** Bytes per page the counts are in — 16384 on Apple Silicon, 4096 on Intel. */
  pageSize: number;
  vm: VmStatistics64;
  /** Absent only if the swap sysctl could not be read. */
  swap?: SwapUsage;
}

/** Undefined off darwin, or if the kernel refused any part the figures need. */
export function readDarwinMemory(kernel: DarwinKernel | null = darwinKernel()): DarwinMemorySample | undefined {
  if (!kernel) return undefined;
  const vm = kernel.vmStatistics();
  const pageSize = kernel.sysctlNumber("vm.pagesize");
  if (!vm || pageSize === undefined || !(pageSize > 0)) return undefined;
  const swapBytes = kernel.sysctlBytes("vm.swapusage");
  const swap = swapBytes ? parseXswUsage(swapBytes) : undefined;
  return { pageSize, vm, ...(swap ? { swap } : {}) };
}

/**
 * Pure: the page counts become the same fields Linux fills from `/proc/meminfo`.
 *
 * - The composition bar gets In use / Standby / Free; there is no "Modified",
 *   because macOS publishes no dirty-page count, so that field stays absent and
 *   the bar draws three parts rather than a fourth that claims zero.
 * - The compressor is macOS's zram: what it occupies, and what it saves.
 * - There is no commit charge on macOS, so both commit fields stay absent.
 */
export function toDarwinMemory(totalBytes: number, sample: DarwinMemorySample): MemoryMetrics {
  const { pageSize: page, vm } = sample;
  const total = Math.max(0, totalBytes);
  const app = Math.max(0, vm.internal - vm.purgeable) * page;
  const used = clamp(app + vm.wire * page + vm.compressor * page, 0, total);
  const cached = clamp((vm.external + vm.purgeable) * page, 0, total - used);
  const free = clamp(vm.free * page, 0, total - used - cached);
  const available = cached + free;

  const totalMB = round1(total / MB);
  const usedMB = round1(used / MB);
  return {
    totalMB,
    usedMB,
    availableMB: round1(available / MB),
    percent: totalMB > 0 ? round1((usedMB / totalMB) * 100) : 0,
    inUseBytes: used,
    standbyBytes: cached,
    freeBytes: free,
    cachedMB: round1(cached / MB),
    zramCompressedMB: round1((vm.compressor * page) / MB),
    zramSavingsMB: round1((Math.max(0, vm.uncompressedInCompressor - vm.compressor) * page) / MB),
    ...(sample.swap
      ? { swapTotalMB: round1(sample.swap.totalBytes / MB), swapUsedMB: round1(sample.swap.usedBytes / MB) }
      : {}),
  };
}

/** `total = 9216.00M  used = 8047.00M  free = 1169.00M  (encrypted)` */
const SWAP_RE = /total\s*=\s*([\d.]+)([KMGT])?\b[\s\S]*?used\s*=\s*([\d.]+)([KMGT])?\b/i;

const MB_PER_UNIT: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

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
 * The fallback's reader: `null` on every platform but darwin, so nothing is
 * spawned where the figure already comes from `/proc/meminfo` or from CIM. On
 * darwin it only runs when `readDarwinMemory` could not answer.
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

// ---------------------------------------------------------------- inventory

/** Common JEDEC ids an Intel Mac prints instead of a name. Anything else is
 *  shown as printed, which is still the module's own answer. */
const JEDEC_MANUFACTURERS: Record<string, string> = {
  "0x80AD": "SK Hynix",
  "0x80CE": "Samsung",
  "0x802C": "Micron",
};

/** `system_profiler` sizes are binary: "32 GB" is `hw.memsize` exactly. */
function parseSize(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^\s*([\d.]+)\s*([KMGT])B\s*$/i.exec(text);
  if (!m) return undefined;
  const scale = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 }[m[2]!.toUpperCase() as "K" | "M" | "G" | "T"];
  const n = Number(m[1]) * scale;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * `system_profiler SPMemoryDataType -json`, in its two shapes.
 *
 * Apple Silicon prints ONE entry with no `_items` — the memory is inside the chip
 * package, so it has a type and a maker but no slot — and puts the size under the
 * data type's own name (`"SPMemoryDataType": "32 GB"`). That becomes a single
 * device and `unified: true`, which is what tells the page there are no slots to
 * count and no capacity to grow into.
 *
 * An Intel Mac prints a "Memory Slots" entry whose `_items` are the slots, empty
 * ones included (`dimm_size: "empty"`), which is how the slot total is known.
 */
export function parseSpMemory(json: string): MemoryInfo | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return undefined;
  }
  const entries = (doc as { SPMemoryDataType?: unknown })?.SPMemoryDataType;
  if (!Array.isArray(entries) || entries.length === 0) return undefined;

  const withSlots = entries.find((e) => Array.isArray((e as { _items?: unknown })?._items)) as
    | { _items: Record<string, unknown>[] }
    | undefined;
  if (withSlots) {
    const devices: MemoryDeviceInfo[] = [];
    for (const slot of withSlots._items) {
      const sizeBytes = parseSize(slot.dimm_size);
      const locator = str(slot._name);
      if (!sizeBytes || !locator) continue; // an empty slot
      const speed = /^(\d+)\s*M/i.exec(str(slot.dimm_speed) ?? "");
      const maker = str(slot.dimm_manufacturer);
      devices.push({
        locator,
        sizeBytes,
        ...(str(slot.dimm_type) ? { ramType: str(slot.dimm_type) } : {}),
        // Printed as MHz; what it is is the transfer rate, as on the Linux page.
        ...(speed ? { speedMts: Number(speed[1]) } : {}),
        ...(maker ? { manufacturer: JEDEC_MANUFACTURERS[maker.toUpperCase().replace(/^0X/, "0x")] ?? maker } : {}),
      });
    }
    return { devices, slotsTotal: withSlots._items.length };
  }

  const unified = entries[0] as Record<string, unknown>;
  const sizeBytes = parseSize(unified.SPMemoryDataType) ?? parseSize(unified.dimm_size);
  if (!sizeBytes) return undefined;
  const maker = str(unified.dimm_manufacturer);
  return {
    unified: true,
    devices: [{
      locator: "Unified memory",
      sizeBytes,
      ...(str(unified.dimm_type) ? { ramType: str(unified.dimm_type) } : {}),
      ...(maker ? { manufacturer: maker } : {}),
    }],
  };
}

let memoryInfo: Promise<MemoryInfo | undefined> | undefined;

/** 0.13-0.26 s, so it is asked once: the modules cannot change while the machine
 *  is up. A failed read is not kept, and the next inventory request asks again. */
export function readDarwinMemoryInfo(run: Runner = defaultRunner): Promise<MemoryInfo | undefined> {
  if (run !== defaultRunner) return fetchMemoryInfo(run);
  memoryInfo ??= fetchMemoryInfo(run).then((info) => {
    if (!info) memoryInfo = undefined;
    return info;
  });
  return memoryInfo;
}

async function fetchMemoryInfo(run: Runner): Promise<MemoryInfo | undefined> {
  if (process.platform !== "darwin" && run === defaultRunner) return undefined;
  try {
    const result = await run(["system_profiler", "SPMemoryDataType", "-json"], 10_000);
    return result.code === 0 ? parseSpMemory(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}
