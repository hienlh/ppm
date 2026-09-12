/** Per-OS collector wiring for the snapshot service. Nothing here spawns until
 *  a full-tier tick actually calls a collector. */
import type { MetricsPlatform } from "../../types/system-metrics.ts";
import type { AppCollector } from "../system-services/apps-linux.ts";
import { createLinuxAppCollector } from "../system-services/apps-linux.ts";
import type { ProcessCollector } from "./process-collector-types.ts";
import { EMPTY_PROCESS_COLLECTOR } from "./process-collector-types.ts";
import type { DiskNetCounters } from "./disk-net-collector-linux.ts";
import type { DeviceCollector } from "./device-collector-types.ts";
import { collectLinuxDevices } from "./device-collector-linux.ts";
import { createDrmGpuCollector } from "./gpu-fdinfo-linux.ts";
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
  /** Per-drive and per-interface figures. Null where the host has no source for
   *  them, which the client reads as "this machine lists no devices". */
  devices: DeviceCollector | null;
  /** Desktop applications with a live process. Null off Linux, which has neither
   *  .desktop entries in the XDG sense nor app cgroups to read them from. */
  apps: AppCollector | null;
}

export function toMetricsPlatform(p: NodeJS.Platform = process.platform): MetricsPlatform {
  return p === "win32" || p === "darwin" ? p : "linux";
}

export function createPlatformCollectors(platform: MetricsPlatform = toMetricsPlatform()): PlatformCollectors {
  const gpus = createNvidiaGpuCollector();
  switch (platform) {
    case "win32":
      return { platform, processes: createWindowsProcessCollector(), diskNet: null, gpus, devices: null, apps: null };
    case "darwin":
      return {
        platform,
        processes: createDarwinProcessCollector(undefined, undefined, { net: createDarwinProcessNetCollector() }),
        diskNet: () => collectDarwinDiskNet(),
        gpus,
        devices: null,
        apps: null,
      };
    case "linux": {
      // ONE collector for both: the whole-GPU figures and the process rows are
      // built from the same `/proc` walk, so they can never disagree, and the
      // walk is paid for once per tick rather than twice.
      const drm = createDrmGpuCollector();
      // Its desktop-entry scan is lazy, so a host where nobody opens the Apps
      // page never pays for it.
      const apps = createLinuxAppCollector();
      return {
        platform,
        processes: createLinuxProcessCollector(readProcTable, {
          gpuMemory: createNvidiaProcessMemoryCollector(),
          drm,
        }),
        diskNet: async () => collectLinuxDiskNet(),
        gpus,
        devices: (prev) => collectLinuxDevices(prev, drm),
        apps: (processes) => apps.collect(processes),
      };
    }
    default:
      return { platform, processes: EMPTY_PROCESS_COLLECTOR, diskNet: null, gpus, devices: null, apps: null };
  }
}
