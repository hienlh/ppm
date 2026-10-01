/**
 * Static hardware facts, served by `GET /api/system/hardware` instead of riding
 * every 2 s snapshot: a drive's model and capacity do not change, and sending
 * them 1800 times an hour over a tunnel would be the largest part of the frame.
 *
 * Async only because the OpenGL/Vulkan versions come from a one-shot tool; that
 * result is cached for the process lifetime, so every call after the first is
 * a handful of small sysfs and udev reads with no cache and no subprocess — a
 * drive plugged in is visible on the client's next refetch rather than after a TTL.
 */
import type { DiskInfo, HardwareInventory, NicInfo } from "../../types/system-hardware.ts";
import type { GpuInfo, MetricsPlatform } from "../../types/system-metrics.ts";
import { toMetricsPlatform } from "./system-metrics-platform.ts";
import { readDiskInventory } from "./disk-inventory-linux.ts";
import { attachPartitionUsage } from "./partitions-linux.ts";
import { readNicInventory } from "./net-inventory-linux.ts";
import { readCpuInfo } from "./cpu-details-linux.ts";
import { readMemoryInfo } from "./memory-linux.ts";
import { maxCpuMHz, readDarwinCpuInfo, readPmgrDvfs } from "./cpu-details-darwin.ts";
import { readDarwinMemoryInfo } from "./memory-darwin.ts";
import { readDarwinDiskInventory } from "./disk-inventory-darwin.ts";
import { readDarwinNicInventory } from "./net-inventory-darwin.ts";
import { readDarwinGpuInventory } from "./gpu-darwin.ts";
import { darwinToolReads } from "./darwin-tool-reads.ts";
import type { DarwinKernel } from "./darwin-ffi.ts";
import { darwinKernel } from "./darwin-ffi.ts";
import { listGpuCards, readGpuInfo } from "./gpu-devices-linux.ts";
import { createGpuApiVersionReader, type GpuApiVersionReader } from "./gpu-api-versions.ts";
import { realLinuxFs } from "./linux-fs.ts";

const apiVersions = createGpuApiVersionReader();

/** What the darwin branch reads, injectable so it is testable on any host. */
export interface DarwinInventorySources {
  kernel: () => DarwinKernel | null;
  dvfs: typeof readPmgrDvfs;
  memory: typeof readDarwinMemoryInfo;
  disks: () => Promise<DiskInfo[]>;
  nics: () => Promise<NicInfo[]>;
  gpus: () => Promise<GpuInfo[]>;
}

const DARWIN_SOURCES: DarwinInventorySources = {
  kernel: darwinKernel,
  dvfs: () => readPmgrDvfs(),
  memory: () => readDarwinMemoryInfo(),
  // The tick's own tool reads, so a request right after a tick spawns nothing.
  disks: () => readDarwinDiskInventory(darwinToolReads()),
  nics: () => readDarwinNicInventory(darwinToolReads()),
  gpus: () => readDarwinGpuInventory(darwinToolReads()),
};

/** Windows reports no devices yet; the client hides the sections rather than
 *  showing empty ones, exactly as it does for a host with no GPU. */
export async function readHardwareInventory(
  platform: MetricsPlatform = toMetricsPlatform(),
  now: () => number = Date.now,
  api: GpuApiVersionReader = apiVersions,
  darwin: DarwinInventorySources = DARWIN_SOURCES,
): Promise<HardwareInventory> {
  const base = { platform, ts: now(), disks: [], nics: [], gpus: [] } satisfies HardwareInventory;
  if (platform === "darwin") return readDarwinInventory(base, darwin);
  if (platform !== "linux") return base;

  const cpu = readCpuInfo();
  const versions = await api.read();
  // statfs per mount, off the event loop and in parallel — see partitions-linux.
  const disks = readDiskInventory();
  await attachPartitionUsage(disks);
  return {
    ...base,
    disks,
    nics: readNicInventory(),
    memory: readMemoryInfo(),
    // NVIDIA is deliberately included here: the static facts (name, PCIe link)
    // come from sysfs for every driver, even where the live figures do not.
    gpus: listGpuCards(realLinuxFs).map((card) => readGpuInfo(card, versions, realLinuxFs)),
    ...(cpu ? { cpu } : {}),
  };
}

/**
 * Every source in parallel. The power manager's frequency tables, the memory
 * modules and the GPUs' Metal version are cached after their first success, so
 * only the first request of a server's life waits for them (~0.7 s, the two
 * `system_profiler` calls running side by side); the drives and interfaces are
 * re-read on every request, which is what makes a drive plugged in visible on the
 * client's next refetch.
 */
async function readDarwinInventory(base: HardwareInventory, sources: DarwinInventorySources): Promise<HardwareInventory> {
  const [dvfs, memory, disks, nics, gpus] = await Promise.all([
    sources.dvfs(), sources.memory(), sources.disks(), sources.nics(), sources.gpus(),
  ]);
  const cpu = readDarwinCpuInfo(sources.kernel(), maxCpuMHz(dvfs));
  return { ...base, disks, nics, gpus, ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) };
}
