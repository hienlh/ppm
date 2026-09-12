/**
 * Mission Center's CPU page, from `/sys/devices/system/cpu`, `/proc` and hwmon.
 * Split in two: the static facts go in the hardware inventory (they cannot change
 * while the kernel is up), the live ones ride the tick.
 *
 * Package power is RAPL's cumulative energy counter, so it needs two samples like
 * any other rate — the caller keeps the previous one.
 */
import type { CpuInfo } from "../../types/system-hardware.ts";
import { readAttr, readNumber, realLinuxFs, type LinuxFs } from "./linux-fs.ts";

export const SYS_CPU = "/sys/devices/system/cpu";
const RAPL_DIR = "/sys/class/powercap";
const HWMON_DIR = "/sys/class/hwmon";

/** `/sys/class/hwmon/<h>/name` of the package sensor, in preference order. */
const PACKAGE_SENSORS = ["coretemp", "k10temp", "zenpower"];

// ---------------------------------------------------------------- static

export function readCpuInfo(fs: LinuxFs = realLinuxFs): CpuInfo | undefined {
  const cpuinfo = fs.read("/proc/cpuinfo");
  if (!cpuinfo) return undefined;
  const topology = parseCpuinfoTopology(cpuinfo);
  const caches = readCacheSizes(fs);

  return {
    name: topology.model,
    sockets: topology.sockets,
    physicalCores: topology.physicalCores,
    logicalCores: topology.logicalCores,
    ...defined("baseMHz", khzToMhz(readNumber(fs, `${SYS_CPU}/cpu0/cpufreq/base_frequency`))),
    ...defined("maxMHz", khzToMhz(readNumber(fs, `${SYS_CPU}/cpu0/cpufreq/cpuinfo_max_freq`))),
    ...defined("virtualization", virtualizationName(topology.flags)),
    isVirtualMachine: topology.flags.has("hypervisor"),
    ...defined("l1CacheBytes", caches.l1),
    ...defined("l2CacheBytes", caches.l2),
    ...defined("l3CacheBytes", caches.l3),
    ...defined("freqDriver", readAttr(fs, `${SYS_CPU}/cpu0/cpufreq/scaling_driver`)),
    ...defined("freqGovernor", readAttr(fs, `${SYS_CPU}/cpu0/cpufreq/scaling_governor`)),
    ...defined("powerPreference", readAttr(fs, `${SYS_CPU}/cpu0/cpufreq/energy_performance_preference`)),
  };
}

export interface CpuTopology {
  model: string;
  logicalCores: number;
  physicalCores: number;
  sockets: number;
  flags: Set<string>;
}

/** `/proc/cpuinfo` is one block per logical CPU. Sockets are the distinct
 *  `physical id`s; physical cores are `cpu cores` summed once per socket, which
 *  is right for a hybrid part too — the kernel reports the real count there. */
export function parseCpuinfoTopology(text: string): CpuTopology {
  let model = "";
  const flags = new Set<string>();
  const coresPerSocket = new Map<string, number>();
  let logicalCores = 0;
  let currentSocket = "0";

  for (const line of text.split("\n")) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === "processor") { logicalCores++; currentSocket = "0"; }
    else if (key === "model name" && !model) model = value;
    else if (key === "physical id") currentSocket = value;
    else if (key === "cpu cores") coresPerSocket.set(currentSocket, Number(value) || 0);
    else if (key === "flags" && flags.size === 0) for (const f of value.split(/\s+/)) flags.add(f);
  }

  const sockets = Math.max(coresPerSocket.size, 1);
  let physicalCores = 0;
  for (const n of coresPerSocket.values()) physicalCores += n;
  return { model, logicalCores, physicalCores: physicalCores || logicalCores, sockets, flags };
}

/** Intel publishes `vmx`, AMD `svm`. Mission Center prints the marketing name. */
export function virtualizationName(flags: ReadonlySet<string>): string | undefined {
  if (flags.has("vmx")) return "Intel VT-x";
  if (flags.has("svm")) return "AMD-V";
  return undefined;
}

/** Cache sizes summed over DISTINCT caches: every CPU sharing one reports the
 *  same `shared_cpu_list`, so that string is the deduplication key. L1 combines
 *  data and instruction, which is what Mission Center shows as one figure. */
export function readCacheSizes(fs: Pick<LinuxFs, "list" | "read">): { l1?: number; l2?: number; l3?: number } {
  const seen = new Set<string>();
  const totals = new Map<number, number>();

  for (const cpu of fs.list(SYS_CPU) ?? []) {
    if (!/^cpu\d+$/.test(cpu)) continue;
    const cacheDir = `${SYS_CPU}/${cpu}/cache`;
    for (const index of fs.list(cacheDir) ?? []) {
      if (!index.startsWith("index")) continue;
      const dir = `${cacheDir}/${index}`;
      const level = readNumber(fs, `${dir}/level`);
      const size = parseCacheSize(readAttr(fs, `${dir}/size`));
      const shared = readAttr(fs, `${dir}/shared_cpu_list`);
      if (level === undefined || size === undefined) continue;
      const key = `${level}:${readAttr(fs, `${dir}/type`) ?? ""}:${shared ?? `${cpu}/${index}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      totals.set(level, (totals.get(level) ?? 0) + size);
    }
  }
  return {
    ...defined("l1", totals.get(1)),
    ...defined("l2", totals.get(2)),
    ...defined("l3", totals.get(3)),
  };
}

/** sysfs writes cache sizes as "48K" / "30720K" / "16M". */
export function parseCacheSize(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d+)([KMG])?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toUpperCase();
  const scale = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return n * scale;
}

// ---------------------------------------------------------------- live

export interface RaplSample {
  microjoules: number;
  atSec: number;
}

export interface CpuLiveExtras {
  currentMHz?: number;
  tempC?: number;
  powerW?: number;
  threadCount?: number;
  handleCount?: number;
  uptimeSec?: number;
}

export interface CpuLiveResult {
  extras: CpuLiveExtras;
  /** RAPL baseline to hand back on the next tick; null when the host has none. */
  rapl: RaplSample | null;
}

export function collectCpuLive(
  prevRapl: RaplSample | null,
  fs: Pick<LinuxFs, "list" | "read"> = realLinuxFs,
  now: () => number = Date.now,
): CpuLiveResult {
  const atSec = now() / 1000;
  const rapl = readRaplEnergy(fs, atSec);
  const loadavg = fs.read("/proc/loadavg") ?? "";

  return {
    rapl,
    extras: {
      ...defined("currentMHz", meanCurrentMHz(fs)),
      ...defined("tempC", readPackageTempC(fs)),
      ...defined("powerW", raplWatts(prevRapl, rapl)),
      ...defined("threadCount", parseThreadCount(loadavg)),
      ...defined("handleCount", parseHandleCount(fs.read("/proc/sys/fs/file-nr"))),
      ...defined("uptimeSec", parseUptimeSec(fs.read("/proc/uptime"))),
    },
  };
}

/** Mean of every online core's current clock. `scaling_cur_freq` is what the
 *  governor asked for; `cpuinfo_cur_freq` needs root on some drivers, so it is
 *  never read here. */
export function meanCurrentMHz(fs: Pick<LinuxFs, "list" | "read">): number | undefined {
  let sum = 0;
  let count = 0;
  for (const cpu of fs.list(SYS_CPU) ?? []) {
    if (!/^cpu\d+$/.test(cpu)) continue;
    const khz = readNumber(fs, `${SYS_CPU}/${cpu}/cpufreq/scaling_cur_freq`);
    if (khz === undefined) continue;
    sum += khz;
    count++;
  }
  return count > 0 ? Math.round(sum / count / 1000) : undefined;
}

/** The package sensor, in preference order; `temp1_input` is the package on
 *  coretemp ("Package id 0") and the die on k10temp. */
export function readPackageTempC(fs: Pick<LinuxFs, "list" | "read">): number | undefined {
  const chips = fs.list(HWMON_DIR) ?? [];
  for (const wanted of PACKAGE_SENSORS) {
    for (const chip of chips) {
      if (readAttr(fs, `${HWMON_DIR}/${chip}/name`) !== wanted) continue;
      const milli = readNumber(fs, `${HWMON_DIR}/${chip}/temp1_input`);
      if (milli !== undefined) return Math.round(milli / 100) / 10;
    }
  }
  return undefined;
}

/** Sum of every RAPL package domain. Intel exposes `intel-rapl:N`, AMD the same
 *  interface; a host with neither (a VM, an ARM board) reports no power at all. */
export function readRaplEnergy(fs: Pick<LinuxFs, "list" | "read">, atSec: number): RaplSample | null {
  let microjoules = 0;
  let found = false;
  for (const entry of fs.list(RAPL_DIR) ?? []) {
    if (!/^intel-rapl:\d+$/.test(entry)) continue;
    const name = readAttr(fs, `${RAPL_DIR}/${entry}/name`) ?? "";
    if (!name.startsWith("package")) continue;
    const uj = readNumber(fs, `${RAPL_DIR}/${entry}/energy_uj`);
    if (uj === undefined) continue;
    microjoules += uj;
    found = true;
  }
  return found ? { microjoules, atSec } : null;
}

/** Watts over the interval. The counter wraps at `max_energy_range_uj`, which a
 *  negative delta reveals — one unmeasured tick is better than a false spike. */
export function raplWatts(prev: RaplSample | null, next: RaplSample | null): number | undefined {
  if (!prev || !next) return undefined;
  const dt = next.atSec - prev.atSec;
  const dj = next.microjoules - prev.microjoules;
  if (!(dt > 0) || dj < 0) return undefined;
  return Math.round(dj / dt / 1000) / 1000;
}

/** `/proc/loadavg`'s fourth field is `running/total` kernel tasks. */
export function parseThreadCount(loadavg: string): number | undefined {
  const m = /\s(\d+)\/(\d+)\s/.exec(` ${loadavg.trim()} `);
  const n = m ? Number(m[2]) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** `/proc/sys/fs/file-nr`: allocated, free, max. The first is the live count. */
export function parseHandleCount(fileNr: string | null): number | undefined {
  const n = Number(fileNr?.trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : undefined;
}

export function parseUptimeSec(uptime: string | null): number | undefined {
  const n = Number(uptime?.trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

const khzToMhz = (khz: number | undefined) => (khz === undefined ? undefined : Math.round(khz / 1000));

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
