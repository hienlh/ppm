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
import type { HardwareInventory } from "../../types/system-hardware.ts";
import type { MetricsPlatform } from "../../types/system-metrics.ts";
import { toMetricsPlatform } from "./system-metrics-platform.ts";
import { readDiskInventory } from "./disk-inventory-linux.ts";
import { attachPartitionUsage } from "./partitions-linux.ts";
import { readNicInventory } from "./net-inventory-linux.ts";
import { readCpuInfo } from "./cpu-details-linux.ts";
import { readMemoryInfo } from "./memory-linux.ts";
import { listGpuCards, readGpuInfo } from "./gpu-devices-linux.ts";
import { createGpuApiVersionReader, type GpuApiVersionReader } from "./gpu-api-versions.ts";
import { realLinuxFs } from "./linux-fs.ts";

const apiVersions = createGpuApiVersionReader();

/** Windows and macOS report no devices yet; the client hides the sections rather
 *  than showing empty ones, exactly as it does for a host with no GPU. */
export async function readHardwareInventory(
  platform: MetricsPlatform = toMetricsPlatform(),
  now: () => number = Date.now,
  api: GpuApiVersionReader = apiVersions,
): Promise<HardwareInventory> {
  const base = { platform, ts: now(), disks: [], nics: [], gpus: [] } satisfies HardwareInventory;
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
