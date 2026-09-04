/** Per-OS collector wiring for the snapshot service. Nothing here spawns until
 *  a full-tier tick actually calls a collector. */
import type { MetricsPlatform } from "../../types/system-metrics.ts";
import type { ProcessCollector } from "./process-collector-types.ts";
import { EMPTY_PROCESS_COLLECTOR } from "./process-collector-types.ts";
import type { DiskNetCounters } from "./disk-net-collector-linux.ts";
import { collectLinuxDiskNet } from "./disk-net-collector-linux.ts";
import { collectDarwinDiskNet } from "./disk-net-collector-darwin.ts";
import { createNvidiaGpuCollector, type GpuCollector } from "./gpu-collector-nvidia.ts";
import { createNvidiaProcessMemoryCollector } from "./gpu-process-memory-nvidia.ts";
import { createLinuxProcessCollector } from "./process-collector-linux.ts";
import { createDarwinProcessCollector } from "./process-collector-darwin.ts";
import { createDarwinProcessNetCollector } from "./process-net-collector-darwin.ts";
import { createWindowsProcessCollector } from "./process-collector-windows.ts";
import { readProcTable } from "../proc-table-linux.ts";

export interface PlatformCollectors {
  platform: MetricsPlatform;
  processes: ProcessCollector;
  /** Null on win32: the counters ride along in the process round trip. */
  diskNet: (() => Promise<DiskNetCounters>) | null;
  gpus: GpuCollector;
}

export function toMetricsPlatform(p: NodeJS.Platform = process.platform): MetricsPlatform {
  return p === "win32" || p === "darwin" ? p : "linux";
}

export function createPlatformCollectors(platform: MetricsPlatform = toMetricsPlatform()): PlatformCollectors {
  const gpus = createNvidiaGpuCollector();
  switch (platform) {
    case "win32":
      return { platform, processes: createWindowsProcessCollector(), diskNet: null, gpus };
    case "darwin":
      return {
        platform,
        processes: createDarwinProcessCollector(undefined, undefined, { net: createDarwinProcessNetCollector() }),
        diskNet: () => collectDarwinDiskNet(),
        gpus,
      };
    case "linux":
      return {
        platform,
        processes: createLinuxProcessCollector(readProcTable, { gpuMemory: createNvidiaProcessMemoryCollector() }),
        diskNet: async () => collectLinuxDiskNet(),
        gpus,
      };
    default:
      return { platform, processes: EMPTY_PROCESS_COLLECTOR, diskNet: null, gpus };
  }
}
