/**
 * The Mac's GPU for the Performance page and the Processes table's GPU column,
 * both out of ONE `ioreg -a -r -l -d 2 -c IOAccelerator` read a tick.
 *
 * The accelerator node carries the whole-GPU figures (`PerformanceStatistics`:
 * "Device Utilization %", the system memory the GPU holds) and each child is one
 * process's connection to it: `IOUserClientCreator` = "pid 164, WindowServer",
 * and `AppUsage[]` = one entry per command queue with `accumulatedGPUTime`, in
 * nanoseconds — its `lastSubmittedTime` matched `CLOCK_UPTIME_RAW` to 0.01 s on an
 * M1 Max, which is what fixes the unit.
 *
 * So a process's GPU % is its clients' GPU time over the wall interval, the way
 * Linux reads fdinfo engine counters. Summed over processes it can pass the device
 * figure (25.7 % against 21 % measured), because two clients' work runs on the
 * GPU's cores at once — which is why the table's footer shows the device figure.
 */
import os from "node:os";
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import type { GpuInfo, GpuMetrics } from "../../types/system-metrics.ts";
import { darwinToolReads, type DarwinToolReads, type ToolRead } from "./darwin-tool-reads.ts";
import {
  plistArray, plistData, plistDict, plistNumber, plistString, type PlistDict, type PlistValue,
} from "./plist-xml.ts";

/** PCI vendor ids, as the accelerator's 4-byte little-endian `vendor-id`. */
const VENDORS: Record<number, string> = { 0x106b: "Apple", 0x8086: "Intel", 0x1002: "AMD", 0x10de: "NVIDIA" };
const MB = 1024 * 1024;

export interface DarwinGpuClient {
  /** The client's registry entry id: what its baseline is kept under. */
  key: string;
  pid: number;
  /** Σ `AppUsage[].accumulatedGPUTime`, ns. */
  gpuTimeNs: number;
}

export interface DarwinAccelerator {
  /** `<driver>-<n>`, the contract's id for a GPU with no PCI address. */
  id: string;
  name: string;
  vendor?: string;
  /** The driver's bundle, short: "AGXG13X". */
  driver?: string;
  driverVersion?: string;
  coreCount?: number;
  utilPercent?: number;
  /** System memory the GPU holds now ("In use system memory"). */
  inUseBytes?: number;
  /** Dedicated memory, on a GPU that has some — an Intel Mac's AMD card, whose
   *  driver publishes it as used + free. Unverified: no such Mac to measure on. */
  vramUsedBytes?: number;
  vramTotalBytes?: number;
  clients: DarwinGpuClient[];
}

/** Every accelerator in the read, in registry order. */
export function parseAccelerators(root: PlistValue | undefined): DarwinAccelerator[] {
  return (plistArray(root) ?? []).flatMap((entry, index) => {
    const node = plistDict(entry);
    return node ? [parseAccelerator(node, index)] : [];
  });
}

function parseAccelerator(node: PlistDict, index: number): DarwinAccelerator {
  const stats = plistDict(node.PerformanceStatistics) ?? {};
  const ioClass = plistString(node.IOClass) ?? "gpu";
  const driver = plistString(node.CFBundleIdentifier)?.split(".").pop() || undefined;
  const vendor = vendorName(plistData(node["vendor-id"]));
  const util = plistNumber(stats["Device Utilization %"]);
  const vramUsed = plistNumber(stats.vramUsedBytes);
  const vramFree = plistNumber(stats.vramFreeBytes);
  return {
    id: `${(driver ?? ioClass).toLowerCase()}-${index}`,
    name: plistString(node.model)?.trim() || ioClass,
    ...defined("vendor", vendor),
    ...defined("driver", driver),
    ...defined("driverVersion", plistString(node.IOSourceVersion) || undefined),
    ...defined("coreCount", plistNumber(node["gpu-core-count"])),
    ...defined("utilPercent", util === undefined ? undefined : Math.min(100, Math.max(0, util))),
    ...defined("inUseBytes", plistNumber(stats["In use system memory"])),
    ...(vramUsed !== undefined && vramFree !== undefined
      ? { vramUsedBytes: vramUsed, vramTotalBytes: vramUsed + vramFree }
      : {}),
    clients: parseClients(plistArray(node.IORegistryEntryChildren) ?? []),
  };
}

/** A child with no creator is not a process's connection, and one with no
 *  registry id has nothing its next sample could be measured against. */
function parseClients(children: readonly PlistValue[]): DarwinGpuClient[] {
  const clients: DarwinGpuClient[] = [];
  for (const child of children) {
    const c = plistDict(child);
    const pid = Number(/^pid (\d+),/.exec(plistString(c?.IOUserClientCreator) ?? "")?.[1]);
    const id = plistNumber(c?.IORegistryEntryID);
    if (!c || !(pid > 0) || id === undefined) continue;
    let gpuTimeNs = 0;
    for (const use of plistArray(c.AppUsage) ?? []) gpuTimeNs += plistNumber(plistDict(use)?.accumulatedGPUTime) ?? 0;
    clients.push({ key: String(id), pid, gpuTimeNs });
  }
  return clients;
}

function vendorName(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.byteLength < 2) return undefined;
  return VENDORS[bytes[0]! | (bytes[1]! << 8)];
}

// ------------------------------------------------------------- per process

/** Each client's GPU time at one read. */
export interface DarwinGpuClientState {
  atSec: number;
  byClient: Map<string, number>;
}

export function toClientState(accelerators: readonly DarwinAccelerator[], atSec: number): DarwinGpuClientState {
  const byClient = new Map<string, number>();
  for (const a of accelerators) for (const c of a.clients) byClient.set(c.key, c.gpuTimeNs);
  return { atSec, byClient };
}

/**
 * pid → GPU %, 0-100 to one decimal. A client that did not exist at the previous
 * read contributes nothing this time — measuring its whole lifetime against one
 * interval is how a window opened a moment ago would read as 4000 %. A client
 * whose total went down (a command queue closed) contributes nothing either.
 */
export function computeDarwinGpuUsage(
  prev: DarwinGpuClientState | null,
  accelerators: readonly DarwinAccelerator[],
  atSec: number,
): Map<number, number> {
  const perProcess = new Map<number, number>();
  const dtNs = prev ? (atSec - prev.atSec) * 1e9 : 0;
  if (!prev || !(dtNs > 0)) return perProcess;
  for (const a of accelerators) {
    for (const c of a.clients) {
      const before = prev.byClient.get(c.key);
      const delta = before === undefined ? 0 : c.gpuTimeNs - before;
      if (delta > 0) perProcess.set(c.pid, (perProcess.get(c.pid) ?? 0) + (delta / dtNs) * 100);
    }
  }
  for (const [pid, pct] of perProcess) perProcess.set(pid, Math.round(Math.min(100, pct) * 10) / 10);
  return perProcess;
}

export interface DarwinGpuUsage {
  atSec: number;
  accelerators: DarwinAccelerator[];
  /** Empty on the first read, which has no interval to measure over; a pid that is
   *  not in it used no GPU time. */
  perProcess: Map<number, number>;
}

export interface DarwinGpuCollector {
  /** This tick's GPUs and per-process usage. The process table asks first and the
   *  GPU page a moment later; both get the same read, so they cannot disagree.
   *  Undefined when `ioreg` did not answer. */
  usage(): Promise<DarwinGpuUsage | undefined>;
}

/** A failed read keeps the last baseline, so the next good one is measured over
 *  the longer interval instead of starting again from nothing. */
export function createDarwinGpuCollector(
  read: () => Promise<ToolRead<PlistValue> | undefined>,
): DarwinGpuCollector {
  let state: DarwinGpuClientState | null = null;
  let last: { read: ToolRead<PlistValue>; usage: DarwinGpuUsage } | null = null;
  return {
    async usage() {
      const r = await read();
      if (!r) return undefined;
      if (last?.read === r) return last.usage;
      const accelerators = parseAccelerators(r.value);
      const usage: DarwinGpuUsage = { atSec: r.atSec, accelerators, perProcess: computeDarwinGpuUsage(state, accelerators, r.atSec) };
      state = toClientState(accelerators, r.atSec);
      last = { read: r, usage };
      return usage;
    },
  };
}

let shared: DarwinGpuCollector | null = null;

/** The one collector the process table and the GPU page share — two would each
 *  keep a baseline, and the second to ask would measure over no interval at all. */
export function darwinGpuCollector(): DarwinGpuCollector {
  return (shared ??= createDarwinGpuCollector(() => darwinToolReads().accelerators()));
}

// ---------------------------------------------------------------- the page

/** What the sensors say about the GPU, which the registry does not. */
export interface DarwinGpuSensors {
  tempC?: number;
  clockMHz?: number;
  clockMaxMHz?: number;
  powerW?: number;
}

/**
 * One tick's figures for an accelerator, or null for one that reports no
 * utilisation — listing it at 0 % would be a reading nobody took.
 *
 * An Apple GPU has no memory of its own: what it holds is system memory, so the
 * page draws it against the machine's RAM, as Linux does for an Intel iGPU. The
 * temperature, clock and power are attached by the caller, because neither the
 * SMC nor IOReport says which GPU a reading belongs to.
 */
export function toDarwinGpuMetrics(
  a: DarwinAccelerator,
  { tempC, clockMHz, clockMaxMHz, powerW, totalRamBytes = os.totalmem() }: DarwinGpuSensors & { totalRamBytes?: number } = {},
): GpuMetrics | null {
  if (a.utilPercent === undefined) return null;
  const vram = a.vramTotalBytes !== undefined && a.vramTotalBytes > 0;
  return {
    id: a.id,
    name: a.name,
    utilPercent: a.utilPercent,
    vramUsedMB: vram ? Math.round(a.vramUsedBytes! / MB) : 0,
    vramTotalMB: vram ? Math.round(a.vramTotalBytes! / MB) : 0,
    ...(!vram && a.inUseBytes !== undefined && totalRamBytes > 0
      ? { sharedUsedMB: Math.round(a.inUseBytes / MB), sharedTotalMB: Math.round(totalRamBytes / MB) }
      : {}),
    ...defined("clockMHz", clockMHz),
    ...defined("clockMaxMHz", clockMaxMHz),
    ...defined("powerW", powerW),
    ...defined("tempC", tempC),
  };
}

// --------------------------------------------------------------- inventory

/** What `system_profiler SPDisplaysDataType` adds: the Metal version, which
 *  nothing in the registry states. */
export interface SpDisplaysGpu {
  name: string;
  metalVersion?: string;
  coreCount?: number;
}

export function parseSpDisplays(json: string): SpDisplaysGpu[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (data as { SPDisplaysDataType?: unknown })?.SPDisplaysDataType;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): SpDisplaysGpu[] => {
    const g = raw as Record<string, unknown>;
    const name = str(g.sppci_model) ?? str(g._name);
    if (!name) return [];
    // The one key a capture has shown ("spdisplays_metal3"); any other value is
    // left unstated rather than guessed at.
    const metal = /^spdisplays_metal(\d+)$/.exec(str(g.spdisplays_mtlgpufamilysupport) ?? "");
    const cores = Number(g.sppci_cores);
    return [{
      name,
      ...(metal ? { metalVersion: `Metal ${metal[1]}` } : {}),
      ...(Number.isInteger(cores) && cores > 0 ? { coreCount: cores } : {}),
    }];
  });
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** By name; a Mac with one GPU in each list pairs them whatever they are called. */
export function matchDisplaysGpu(
  a: DarwinAccelerator,
  accelerators: number,
  displays: readonly SpDisplaysGpu[],
): SpDisplaysGpu | undefined {
  return displays.find((d) => d.name === a.name) ?? (accelerators === 1 && displays.length === 1 ? displays[0] : undefined);
}

export function toDarwinGpuInfo(a: DarwinAccelerator, sp?: SpDisplaysGpu): GpuInfo {
  return {
    id: a.id,
    name: a.name,
    ...defined("vendor", a.vendor),
    ...defined("driver", a.driver),
    ...defined("driverVersion", a.driverVersion),
    ...defined("coreCount", a.coreCount ?? sp?.coreCount),
    ...defined("metalVersion", sp?.metalVersion),
  };
}

let displays: Promise<SpDisplaysGpu[] | undefined> | undefined;

/** ~0.7 s, so it is asked once: a Mac's GPUs and the Metal they support do not
 *  change while it is up. A failed read is not kept. */
export function readDarwinSpDisplays(run: Runner = defaultRunner): Promise<SpDisplaysGpu[] | undefined> {
  if (run !== defaultRunner) return fetchSpDisplays(run);
  displays ??= fetchSpDisplays(run).then((gpus) => {
    if (!gpus) displays = undefined;
    return gpus;
  });
  return displays;
}

async function fetchSpDisplays(run: Runner): Promise<SpDisplaysGpu[] | undefined> {
  if (process.platform !== "darwin" && run === defaultRunner) return undefined;
  try {
    const r = await run(["system_profiler", "SPDisplaysDataType", "-json"], 10_000);
    return r.code === 0 ? parseSpDisplays(r.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** The inventory's GPUs, keyed like the tick's. */
export async function readDarwinGpuInventory(
  reads: DarwinToolReads,
  spDisplays: () => Promise<SpDisplaysGpu[] | undefined> = () => readDarwinSpDisplays(),
): Promise<GpuInfo[]> {
  const [read, sp] = await Promise.all([reads.accelerators(), spDisplays()]);
  const accelerators = parseAccelerators(read?.value);
  return accelerators.map((a) => toDarwinGpuInfo(a, matchDisplaysGpu(a, accelerators.length, sp ?? [])));
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
