/**
 * Whole-GPU figures for Mission Center's GPU page, from `/sys/class/drm/card*`.
 *
 * There is no one source: utilisation comes from the DRM fdinfo engine counters
 * where the driver publishes them (Intel, AMD, and the only unprivileged option
 * on Intel at all), from amdgpu's own `gpu_busy_percent` where it exists, and
 * from i915's rc6 idle residency as a last resort. Anything a given driver does
 * not expose stays ABSENT rather than 0, so the page hides the row.
 *
 * NVIDIA keeps its existing `nvidia-smi` collector: the proprietary driver
 * publishes neither fdinfo engine counters nor the sysfs attributes below.
 */
import os from "node:os";
import type { GpuInfo, GpuMetrics } from "../../types/system-metrics.ts";
import { readAttr, readNumber, realLinuxFs, type LinuxFs } from "./linux-fs.ts";
import { readUdevProperties, udevValue } from "./udev-db.ts";
import type { DrmUsage } from "./gpu-fdinfo-linux.ts";

export const DRM_DIR = "/sys/class/drm";
const RAPL_DIR = "/sys/class/powercap";

const VENDORS: Record<string, string> = {
  "0x8086": "Intel",
  "0x1002": "AMD",
  "0x1022": "AMD",
  "0x10de": "NVIDIA",
};

/** `current_link_speed` reads "8.0 GT/s PCIe"; the rate identifies the generation. */
const PCIE_GEN_BY_RATE: Record<string, number> = {
  "2.5": 1, "5.0": 2, "8.0": 3, "16.0": 4, "32.0": 5, "64.0": 6,
};

export interface GpuCard {
  /** "card1". */
  card: string;
  /** PCI address — the id both `GpuMetrics` and `GpuInfo` are keyed by. */
  pdev: string;
  driver: string;
  vendor?: string;
}

/** Real render nodes only: `card1-DP-1` is a connector, not a device, and a
 *  driver with no PCI parent (vkms, a virtio display) has nothing to report. */
export function listGpuCards(fs: Pick<LinuxFs, "list" | "read" | "readlink" | "realpath">): GpuCard[] {
  const cards: GpuCard[] = [];
  for (const entry of (fs.list(DRM_DIR) ?? []).sort()) {
    if (!/^card\d+$/.test(entry)) continue;
    const real = fs.realpath(`${DRM_DIR}/${entry}/device`);
    const pdev = real ? real.slice(real.lastIndexOf("/") + 1) : "";
    if (!/^[0-9a-f]{4}:/i.test(pdev)) continue;
    const driver = basename(fs.readlink(`${DRM_DIR}/${entry}/device/driver`) ?? "");
    const vendorId = readAttr(fs, `${DRM_DIR}/${entry}/device/vendor`);
    cards.push({
      card: entry,
      pdev,
      driver,
      ...(vendorId && VENDORS[vendorId] ? { vendor: VENDORS[vendorId] } : {}),
    });
  }
  return cards;
}

export interface GpuSample {
  atSec: number;
  /** i915 cumulative idle residency, ms. */
  rc6Ms?: number;
  /** RAPL uncore energy, µJ — the integrated GPU's share of package power. */
  uncoreUj?: number;
}

export type GpuSampleState = Map<string, GpuSample>;

export interface GpuDeviceCollection {
  gpus: GpuMetrics[];
  next: GpuSampleState;
}

export function collectLinuxGpus(
  prev: GpuSampleState,
  usage: DrmUsage,
  fs: Pick<LinuxFs, "list" | "read" | "readlink" | "realpath"> = realLinuxFs,
  now: () => number = Date.now,
  totalRamBytes: number = os.totalmem(),
): GpuDeviceCollection {
  const atSec = now() / 1000;
  const uncoreUj = readUncoreEnergy(fs);
  const next: GpuSampleState = new Map();
  const gpus: GpuMetrics[] = [];

  for (const card of listGpuCards(fs)) {
    // NVIDIA is covered by the nvidia-smi collector; listing it here too would
    // publish the same GPU twice with half the figures missing.
    if (card.driver === "nvidia" || card.driver === "nouveau") continue;
    const dir = `${DRM_DIR}/${card.card}`;
    const sample: GpuSample = {
      atSec,
      ...defined("rc6Ms", readNumber(fs, `${dir}/power/rc6_residency_ms`)),
      ...defined("uncoreUj", uncoreUj),
    };
    next.set(card.card, sample);
    gpus.push(buildGpuMetrics(card, dir, prev.get(card.card) ?? null, sample, usage, fs, totalRamBytes));
  }
  return { gpus, next };
}

function buildGpuMetrics(
  card: GpuCard,
  dir: string,
  prev: GpuSample | null,
  next: GpuSample,
  usage: DrmUsage,
  fs: Pick<LinuxFs, "list" | "read">,
  totalRamBytes: number,
): GpuMetrics {
  const engines = usage.perDevice.get(card.pdev);
  const integrated = card.driver === "i915" || card.driver === "xe";
  const vram = readVram(dir, fs);
  const hwmon = findHwmon(dir, fs);

  return {
    id: card.pdev,
    name: gpuName(card, fs),
    utilPercent: utilisation(card, dir, engines, prev, next, fs),
    vramUsedMB: vram.usedMB,
    vramTotalMB: vram.totalMB,
    ...sharedMemory(card, dir, usage, fs, totalRamBytes),
    ...videoEngines(card, engines),
    ...defined("clockMHz", currentClockMHz(card, dir, fs)),
    ...defined("clockMaxMHz", maxClockMHz(card, dir, fs)),
    ...defined("memClockMHz", pickDpmCurrent(readAttr(fs, `${dir}/device/pp_dpm_mclk`))),
    ...defined("powerW", integrated ? uncoreWatts(prev, next) : hwmonPowerW(hwmon, fs)),
    ...defined("tempC", hwmonTempC(hwmon, fs)),
  };
}

/**
 * Engine busy first: it is the only unprivileged per-engine figure Intel has and
 * it matches what the process rows are built from, so the page and the table
 * agree. amdgpu's own counter is preferred over rc6 where fdinfo said nothing,
 * and rc6 is the last resort — it measures IDLE, so busy is its complement.
 */
export function utilisation(
  card: GpuCard,
  dir: string,
  engines: ReadonlyMap<string, number> | undefined,
  prev: GpuSample | null,
  next: GpuSample,
  fs: Pick<LinuxFs, "read">,
): number {
  const render = (engines?.get("render") ?? 0) + (engines?.get("compute") ?? 0);
  if (render > 0) return round1(Math.min(100, render));

  const amdBusy = readNumber(fs, `${dir}/device/gpu_busy_percent`);
  if (amdBusy !== undefined) return round1(Math.min(100, Math.max(0, amdBusy)));

  const rc6 = rc6BusyPercent(prev, next);
  return rc6 ?? 0;
}

/** i915's rc6 counter is cumulative time spent in the deepest idle state. */
export function rc6BusyPercent(prev: GpuSample | null, next: GpuSample): number | undefined {
  if (!prev || prev.rc6Ms === undefined || next.rc6Ms === undefined) return undefined;
  const dtMs = (next.atSec - prev.atSec) * 1000;
  const idle = next.rc6Ms - prev.rc6Ms;
  if (!(dtMs > 0) || idle < 0) return undefined;
  return round1(Math.min(100, Math.max(0, 100 - idle / dtMs * 100)));
}

/** Intel exposes ONE video engine doing both encode and decode, so the page
 *  labels it "Video encode/decode" rather than inventing a second figure. */
function videoEngines(card: GpuCard, engines: ReadonlyMap<string, number> | undefined): Partial<GpuMetrics> {
  if (!engines) return {};
  const video = engines.get("video");
  const enhance = engines.get("video-enhance");
  if (video === undefined && enhance === undefined) return {};
  if (card.driver === "i915" || card.driver === "xe") {
    return { encodePercent: round1(Math.min(100, (video ?? 0) + (enhance ?? 0))) };
  }
  return {
    ...defined("encodePercent", video === undefined ? undefined : round1(video)),
    ...defined("decodePercent", enhance === undefined ? undefined : round1(enhance)),
  };
}

/**
 * System memory the GPU is using — Mission Center's "Memory Usage" on a card
 * with no VRAM of its own, where it is the page's only memory figure.
 *
 * amdgpu's own GTT counters win where they exist: they are the driver's view of
 * its aperture, and the aperture — not system RAM — is that card's ceiling. An
 * integrated GPU publishes neither, so the figure is summed out of its clients'
 * DRM fdinfo against the machine's RAM, which is what Mission Center shows (it
 * read 2.52 GiB / 62.5 GiB here while this summed 2.54 GiB).
 *
 * Both halves must be present or neither is reported: a used figure over an
 * unknown ceiling is not a reading.
 */
export function sharedMemory(
  card: GpuCard,
  dir: string,
  usage: DrmUsage,
  fs: Pick<LinuxFs, "read">,
  totalRamBytes: number,
): Partial<GpuMetrics> {
  const gttUsed = bytesToMB(readNumber(fs, `${dir}/device/mem_info_gtt_used`));
  const gttTotal = bytesToMB(readNumber(fs, `${dir}/device/mem_info_gtt_total`));
  if (gttUsed !== undefined && gttTotal !== undefined) {
    return { sharedUsedMB: gttUsed, sharedTotalMB: gttTotal };
  }
  const fromClients = usage.sharedByDevice.get(card.pdev);
  const ram = bytesToMB(totalRamBytes > 0 ? totalRamBytes : undefined);
  if (fromClients === undefined || ram === undefined) return {};
  return { sharedUsedMB: Math.round(fromClients), sharedTotalMB: ram };
}

/** amdgpu is the only driver here with dedicated memory counters; an integrated
 *  GPU reports a 0 total, which the contract defines as "has none to report". */
function readVram(dir: string, fs: Pick<LinuxFs, "read">): { usedMB: number; totalMB: number } {
  const used = readNumber(fs, `${dir}/device/mem_info_vram_used`);
  const total = readNumber(fs, `${dir}/device/mem_info_vram_total`);
  return { usedMB: bytesToMB(used) ?? 0, totalMB: bytesToMB(total) ?? 0 };
}

/**
 * i915's REQUESTED clock, not its actual one.
 *
 * `gt_act_freq_mhz` is sampled the instant the file is read, and an idle GPU is
 * parked in RC6 for most of any 2 s tick — so it returns 0 far more often than
 * not and the figure flickers between 0 and 1400 MHz beside a fixed maximum,
 * which reads as a broken number rather than as an idle GPU. `gt_cur_freq_mhz`
 * is the frequency the driver is holding the card at and moves with load.
 */
function currentClockMHz(card: GpuCard, dir: string, fs: Pick<LinuxFs, "read">): number | undefined {
  return readNumber(fs, `${dir}/gt_cur_freq_mhz`)
    ?? readNumber(fs, `${dir}/gt_act_freq_mhz`)
    ?? pickDpmCurrent(readAttr(fs, `${dir}/device/pp_dpm_sclk`));
}

function maxClockMHz(card: GpuCard, dir: string, fs: Pick<LinuxFs, "read">): number | undefined {
  return readNumber(fs, `${dir}/gt_RP0_freq_mhz`)
    ?? readNumber(fs, `${dir}/gt_max_freq_mhz`)
    ?? pickDpmMax(readAttr(fs, `${dir}/device/pp_dpm_sclk`));
}

/** amdgpu's DPM tables list one state per line and mark the live one with `*`:
 *  `1: 500Mhz *`. */
export function pickDpmCurrent(table: string | undefined): number | undefined {
  if (!table) return undefined;
  for (const line of table.split("\n")) {
    if (!line.includes("*")) continue;
    const m = /(\d+)\s*Mhz/i.exec(line);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export function pickDpmMax(table: string | undefined): number | undefined {
  if (!table) return undefined;
  let max: number | undefined;
  for (const line of table.split("\n")) {
    const m = /(\d+)\s*Mhz/i.exec(line);
    if (m) max = Math.max(max ?? 0, Number(m[1]));
  }
  return max;
}

/** The card's own hwmon directory, e.g. `.../card0/device/hwmon/hwmon4`. */
function findHwmon(dir: string, fs: Pick<LinuxFs, "list">): string | undefined {
  const base = `${dir}/device/hwmon`;
  const entry = fs.list(base)?.find((n) => n.startsWith("hwmon"));
  return entry ? `${base}/${entry}` : undefined;
}

function hwmonTempC(hwmon: string | undefined, fs: Pick<LinuxFs, "read">): number | undefined {
  if (!hwmon) return undefined;
  const milli = readNumber(fs, `${hwmon}/temp1_input`);
  return milli === undefined ? undefined : Math.round(milli / 100) / 10;
}

/** amdgpu publishes microwatts. */
function hwmonPowerW(hwmon: string | undefined, fs: Pick<LinuxFs, "read">): number | undefined {
  if (!hwmon) return undefined;
  const uw = readNumber(fs, `${hwmon}/power1_average`) ?? readNumber(fs, `${hwmon}/power1_input`);
  return uw === undefined ? undefined : Math.round(uw / 1000) / 1000;
}

/** RAPL's uncore domain is the integrated GPU's slice of the package budget —
 *  the only power figure an Intel iGPU has without root. */
export function readUncoreEnergy(fs: Pick<LinuxFs, "list" | "read">): number | undefined {
  for (const pkg of fs.list(RAPL_DIR) ?? []) {
    if (!/^intel-rapl:\d+$/.test(pkg)) continue;
    for (const sub of fs.list(`${RAPL_DIR}/${pkg}`) ?? []) {
      if (!sub.startsWith("intel-rapl:")) continue;
      if (readAttr(fs, `${RAPL_DIR}/${pkg}/${sub}/name`) !== "uncore") continue;
      const uj = readNumber(fs, `${RAPL_DIR}/${pkg}/${sub}/energy_uj`);
      if (uj !== undefined) return uj;
    }
  }
  return undefined;
}

function uncoreWatts(prev: GpuSample | null, next: GpuSample): number | undefined {
  if (!prev || prev.uncoreUj === undefined || next.uncoreUj === undefined) return undefined;
  const dt = next.atSec - prev.atSec;
  const dj = next.uncoreUj - prev.uncoreUj;
  if (!(dt > 0) || dj < 0) return undefined;
  return Math.round(dj / dt / 1000) / 1000;
}

// ---------------------------------------------------------------- static

export function readGpuInfo(
  card: GpuCard,
  api: { opengl?: string; vulkan?: string; mesa?: string },
  fs: Pick<LinuxFs, "list" | "read">,
): GpuInfo {
  const dir = `${DRM_DIR}/${card.card}`;
  const link = pcieLink(dir, fs);
  return {
    id: card.pdev,
    name: gpuName(card, fs),
    ...defined("vendor", card.vendor),
    ...defined("driver", card.driver || undefined),
    ...defined("driverVersion", readAttr(fs, `/sys/module/${card.driver}/version`) ?? api.mesa),
    ...defined("openglVersion", api.opengl),
    ...defined("vulkanVersion", api.vulkan),
    ...link,
    ...(card.driver === "i915" || card.driver === "xe" ? { encodeDecodeShared: true } : {}),
  };
}

/** The PCI database name udev already resolved, e.g. "Alder Lake-S GT1 [UHD
 *  Graphics 770]". Falls back to the driver, never to an empty string. */
export function gpuName(card: GpuCard, fs: Pick<LinuxFs, "read">): string {
  const props = readUdevProperties(`+pci:${card.pdev}`, fs.read);
  const fallback = [card.vendor, card.driver].filter(Boolean).join(" ");
  return udevValue(props, "ID_MODEL_FROM_DATABASE") ?? (fallback || card.pdev);
}

/** Current and maximum link, with the maximum reported only when it DIFFERS —
 *  Mission Center hides an equal one, and an integrated GPU has no real link at
 *  all (its `current_link_speed` reads "Unknown" and its width 0). */
export function pcieLink(dir: string, fs: Pick<LinuxFs, "read">): Partial<GpuInfo> {
  const gen = pcieGen(readAttr(fs, `${dir}/device/current_link_speed`));
  const lanes = positive(readNumber(fs, `${dir}/device/current_link_width`));
  const maxGen = pcieGen(readAttr(fs, `${dir}/device/max_link_speed`));
  const maxLanes = positive(readNumber(fs, `${dir}/device/max_link_width`));
  if (gen === undefined && lanes === undefined) return {};
  return {
    ...defined("pcieGen", gen),
    ...defined("pcieLanes", lanes),
    ...(maxGen !== undefined && maxGen !== gen ? { pcieMaxGen: maxGen } : {}),
    ...(maxLanes !== undefined && maxLanes !== lanes ? { pcieMaxLanes: maxLanes } : {}),
  };
}

export function pcieGen(speed: string | undefined): number | undefined {
  const m = /^([\d.]+)\s*GT\/s/i.exec(speed?.trim() ?? "");
  return m ? PCIE_GEN_BY_RATE[m[1]!] : undefined;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const round1 = (n: number) => Math.round(n * 10) / 10;
const positive = (n: number | undefined) => (n !== undefined && n > 0 ? n : undefined);
const bytesToMB = (n: number | undefined) => (n === undefined ? undefined : Math.round(n / 1024 ** 2));

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
