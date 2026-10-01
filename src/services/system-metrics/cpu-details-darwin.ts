/**
 * Mission Center's CPU page on a Mac. Split like the Linux one: static facts for
 * the hardware inventory (sysctl, plus the power manager's frequency tables for
 * the top clock), live ones for the tick (the scheduler's thread total, the open
 * file count, and the sensor readings `sensors-darwin.ts` takes once a tick).
 *
 * Apple Silicon is not one CPU but clusters of two kinds. `hw.perflevel<N>.*`
 * describes each kind — core count, per-core L1, per-cluster L2 — and is the only
 * honest source for the caches: the top-level `hw.l1icachesize` family answers
 * for the EFFICIENCY cores alone (128 KiB L1i and a 4 MiB L2 on an M1 Max whose
 * performance cores have 192 KiB and 12 MiB). An Intel Mac has no perf levels
 * and uses `hw.cacheconfig`, which says how many logical CPUs share each level.
 *
 * Nothing Linux-specific is filled: macOS has no cpufreq driver, governor or
 * energy-performance preference, so those stay absent and the page hides them.
 */
import type { CpuInfo } from "../../types/system-hardware.ts";
import type { CpuMetrics } from "../../types/system-metrics.ts";
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import { darwinKernel, isAppleSilicon, type DarwinKernel } from "./darwin-ffi.ts";
import { parsePlistXml, plistArray, plistData, plistDict } from "./plist-xml.ts";
import type { DarwinSensorReadings } from "./sensors-darwin.ts";

// ---------------------------------------------------------------- static

/** One kind of core: `hw.perflevel<N>.*`. */
export interface PerfLevel {
  /** "Performance" or "Efficiency" as the kernel names it. */
  name: string;
  physical: number;
  logical: number;
  l1iBytes?: number;
  l1dBytes?: number;
  l2Bytes?: number;
  /** Cores sharing one L2, i.e. the cluster size. */
  cpusPerL2?: number;
}

export function readPerfLevels(kernel: DarwinKernel): PerfLevel[] {
  const count = kernel.sysctlNumber("hw.nperflevels") ?? 0;
  const levels: PerfLevel[] = [];
  for (let i = 0; i < count; i++) {
    const at = (field: string) => kernel.sysctlNumber(`hw.perflevel${i}.${field}`);
    const name = kernel.sysctlString(`hw.perflevel${i}.name`);
    const physical = at("physicalcpu");
    const logical = at("logicalcpu");
    if (!name || !physical || !logical) continue;
    levels.push({
      name, physical, logical,
      ...defined("l1iBytes", at("l1icachesize")),
      ...defined("l1dBytes", at("l1dcachesize")),
      ...defined("l2Bytes", at("l2cachesize")),
      ...defined("cpusPerL2", at("cpusperl2")),
    });
  }
  return levels;
}

/**
 * Summed over DISTINCT caches, as the Linux page does: L1 is per core (data +
 * instruction), L2 is per cluster. An M1 Max: 8 × (192 + 128) KiB + 2 × (128 +
 * 64) KiB of L1, and two 12 MiB performance-cluster L2s plus one 4 MiB
 * efficiency one. Apple Silicon has no L3 — its system-level cache is shared
 * with the GPU and not published as a CPU cache — so L3 stays absent.
 */
export function cachesFromPerfLevels(levels: readonly PerfLevel[]): { l1?: number; l2?: number } {
  let l1 = 0;
  let l2 = 0;
  let sawL1 = false;
  let sawL2 = false;
  for (const level of levels) {
    if (level.l1iBytes !== undefined || level.l1dBytes !== undefined) {
      l1 += ((level.l1iBytes ?? 0) + (level.l1dBytes ?? 0)) * level.physical;
      sawL1 = true;
    }
    if (level.l2Bytes !== undefined) {
      l2 += level.l2Bytes * Math.ceil(level.physical / Math.max(1, level.cpusPerL2 ?? level.physical));
      sawL2 = true;
    }
  }
  return { ...defined("l1", sawL1 ? l1 : undefined), ...defined("l2", sawL2 ? l2 : undefined) };
}

/** `hw.cacheconfig` / `hw.cachesize`: ten u64s each, index = cache level (0 is
 *  memory). `cacheconfig[n]` logical CPUs share one level-n cache of
 *  `cachesize[n]` bytes; `cachesize[1]` is the DATA cache only, so L1's
 *  instruction half comes from `hw.l1icachesize`. */
export function cachesFromCacheConfig(kernel: DarwinKernel): { l1?: number; l2?: number; l3?: number } {
  const config = u64s(kernel.sysctlBytes("hw.cacheconfig"));
  const sizes = u64s(kernel.sysctlBytes("hw.cachesize"));
  const logical = kernel.sysctlNumber("hw.logicalcpu");
  if (!config || !sizes || !logical) return {};
  const instances = (level: number) => {
    const sharing = config[level] ?? 0;
    return sharing > 0 ? Math.max(1, Math.round(logical / sharing)) : 0;
  };
  const total = (level: number, extra = 0) => {
    const n = instances(level);
    const size = sizes[level] ?? 0;
    return n > 0 && size > 0 ? (size + extra) * n : undefined;
  };
  return {
    ...defined("l1", total(1, kernel.sysctlNumber("hw.l1icachesize") ?? 0)),
    ...defined("l2", total(2)),
    ...defined("l3", total(3)),
  };
}

function u64s(bytes: Uint8Array | undefined): number[] | undefined {
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength % 8 !== 0) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let off = 0; off < bytes.byteLength; off += 8) out.push(Number(v.getBigUint64(off, true)));
  return out;
}

/**
 * `maxMHz` comes from the caller because on Apple Silicon it is not a sysctl at
 * all — see `readPmgrDvfs`. On an Intel Mac `hw.cpufrequency` is the nominal
 * clock; `hw.cpufrequency_max` is only kept when it says something more, since
 * Intel Macs report the nominal clock there too rather than the turbo one.
 */
export function readDarwinCpuInfo(kernel: DarwinKernel | null = darwinKernel(), maxMHz?: number): CpuInfo | undefined {
  if (!kernel) return undefined;
  const name = kernel.sysctlString("machdep.cpu.brand_string");
  const physicalCores = kernel.sysctlNumber("hw.physicalcpu");
  const logicalCores = kernel.sysctlNumber("hw.logicalcpu");
  if (!name || !physicalCores || !logicalCores) return undefined;

  const appleSilicon = isAppleSilicon(kernel);
  const levels = readPerfLevels(kernel);
  const caches: { l1?: number; l2?: number; l3?: number } =
    levels.length > 0 ? cachesFromPerfLevels(levels) : cachesFromCacheConfig(kernel);
  const performance = levels.find((l) => l.name === "Performance");
  const efficiency = levels.find((l) => l.name === "Efficiency");
  const baseMHz = hzToMHz(kernel.sysctlNumber("hw.cpufrequency"));
  const sysctlMax = hzToMHz(kernel.sysctlNumber("hw.cpufrequency_max"));
  const topMHz = sysctlMax !== undefined && (baseMHz === undefined || sysctlMax > baseMHz) ? sysctlMax : maxMHz;

  return {
    name: name.trim(),
    sockets: kernel.sysctlNumber("hw.packages") ?? 1,
    physicalCores,
    logicalCores,
    ...(performance && efficiency
      ? { performanceCores: performance.physical, efficiencyCores: efficiency.physical }
      : {}),
    ...defined("baseMHz", baseMHz),
    ...defined("maxMHz", topMHz),
    ...defined("virtualization", kernel.sysctlNumber("kern.hv_support") === 1
      ? (appleSilicon ? "Apple Hypervisor" : "Intel VT-x")
      : undefined),
    isVirtualMachine: kernel.sysctlNumber("kern.hv_vmm_present") === 1,
    ...defined("l1CacheBytes", caches.l1),
    ...defined("l2CacheBytes", caches.l2),
    ...defined("l3CacheBytes", caches.l3),
  };
}

const hzToMHz = (hz: number | undefined) => (hz !== undefined && hz > 0 ? Math.round(hz / 1e6) : undefined);

// ---------------------------------------------------------------- frequency tables

/** Clock of each performance state, MHz, in the order the power manager lists
 *  them (index = state, which is what IOReport's residencies are keyed by). */
export interface DvfsTables {
  ecpuMHz: number[];
  pcpuMHz: number[];
  gpuMHz: number[];
}

/**
 * One `voltage-states*` blob: little-endian u32 pairs of (frequency, voltage).
 * The frequency is in Hz on the M1 this was measured on; a table whose largest
 * entry is below 10^8 is read as kHz, because a core above 4.29 GHz — an M4's —
 * cannot be written in Hz in a u32 at all. A table with no plausible clock is
 * not a frequency table and yields nothing.
 */
export function parseDvfsTable(bytes: Uint8Array | undefined): number[] {
  if (!bytes || bytes.byteLength < 8) return [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw: number[] = [];
  for (let off = 0; off + 8 <= bytes.byteLength; off += 8) raw.push(v.getUint32(off, true));
  const top = Math.max(...raw);
  const divisor = top >= 1e8 ? 1e6 : top >= 1e5 ? 1e3 : 0;
  return divisor ? raw.map((f) => Math.round(f / divisor)) : [];
}

/**
 * The tables the tools that read them agree on: `voltage-states1-sram` is the
 * efficiency cluster, `voltage-states5-sram` the performance cluster and
 * `voltage-states9` the GPU (the non-`sram` CPU tables hold no clocks). An M1 Max
 * lists a second performance cluster and three more GPU tables with identical
 * clocks, so reading one of each loses nothing.
 */
export function parsePmgrDvfs(xml: string): DvfsTables | undefined {
  const entry = plistDict(plistArray(parsePlistXml(xml))?.[0]);
  if (!entry) return undefined;
  const tables = {
    ecpuMHz: parseDvfsTable(plistData(entry["voltage-states1-sram"])),
    pcpuMHz: parseDvfsTable(plistData(entry["voltage-states5-sram"])),
    gpuMHz: parseDvfsTable(plistData(entry["voltage-states9"])),
  };
  return tables.ecpuMHz.length || tables.pcpuMHz.length || tables.gpuMHz.length ? tables : undefined;
}

/** The fastest any CPU core will run: the top performance state of either kind. */
export function maxCpuMHz(tables: DvfsTables | undefined): number | undefined {
  const all = [...(tables?.ecpuMHz ?? []), ...(tables?.pcpuMHz ?? [])];
  return all.length > 0 ? Math.max(...all) : undefined;
}

let dvfs: Promise<DvfsTables | undefined> | undefined;

/**
 * `ioreg` for the power manager's node alone (19 ms). The tables are burned into
 * the chip, so a successful read is kept for the life of the process; a failed
 * one is not, and the next inventory request asks again.
 */
export function readPmgrDvfs(run: Runner = defaultRunner): Promise<DvfsTables | undefined> {
  if (run !== defaultRunner) return fetchPmgrDvfs(run);
  dvfs ??= fetchPmgrDvfs(run).then((tables) => {
    if (!tables) dvfs = undefined;
    return tables;
  });
  return dvfs;
}

async function fetchPmgrDvfs(run: Runner): Promise<DvfsTables | undefined> {
  if (process.platform !== "darwin" && run === defaultRunner) return undefined;
  try {
    const result = await run(["ioreg", "-a", "-r", "-d", "1", "-n", "pmgr"], 5000);
    if (result.code !== 0 || !result.stdout) return undefined;
    return parsePmgrDvfs(result.stdout);
  } catch {
    // The inventory must answer without a top clock rather than not at all.
    return undefined;
  }
}

// ---------------------------------------------------------------- live

/**
 * The per-tick extras, each absent when the kernel or the sensor behind it did
 * not answer. `threadCount` is every thread the scheduler knows
 * (processor_set_load_info), which is what the Linux page's `/proc/loadavg` total
 * is too; `handleCount` is the kernel's open-file count, the Linux page's
 * `file-nr`. The temperature is the SMC's core sensors; the clock and the power
 * are IOReport's, the clock weighed by how long each core ran at each speed.
 */
export function collectDarwinCpuLive(
  kernel: DarwinKernel | null = darwinKernel(),
  sensors: Pick<DarwinSensorReadings, "cpuC" | "cpuPowerW" | "cpuMHz"> = {},
): Partial<CpuMetrics> {
  const load = kernel?.processorSetLoad();
  return {
    ...defined("threadCount", load?.threadCount),
    ...defined("handleCount", kernel?.sysctlNumber("kern.num_files")),
    ...defined("tempC", sensors.cpuC),
    ...defined("powerW", sensors.cpuPowerW),
    ...defined("currentMHz", sensors.cpuMHz),
  };
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
