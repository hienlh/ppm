/** Per-OS collector wiring for the snapshot service. Nothing here spawns until
 *  a full-tier tick actually calls a collector. */
import type { MetricsPlatform } from "../../types/system-metrics.ts";
import type { AppCollector } from "../system-services/apps-linux.ts";
import { createLinuxAppCollector } from "../system-services/apps-linux.ts";
import { darwinAppCollector } from "../system-services/apps-darwin.ts";
import { windowsAppCollector } from "../system-services/apps-windows.ts";
import { launchdJobIndex } from "../system-services/launchd-job-index.ts";
import type { ProcessCollector } from "./process-collector-types.ts";
import { EMPTY_PROCESS_COLLECTOR } from "./process-collector-types.ts";
import type { DiskNetCounters } from "./disk-net-collector-linux.ts";
import type { DeviceCollector } from "./device-collector-types.ts";
import { collectLinuxDevices } from "./device-collector-linux.ts";
import { collectDarwinDevices } from "./device-collector-darwin.ts";
import { createDrmGpuCollector } from "./gpu-fdinfo-linux.ts";
import { collectLinuxDiskNet } from "./disk-net-collector-linux.ts";
import { collectDarwinDiskNet } from "./disk-net-collector-darwin.ts";
import { createNvidiaGpuCollector, type GpuCollector } from "./gpu-collector-nvidia.ts";
import { createNvidiaProcessMemoryCollector } from "./gpu-process-memory-nvidia.ts";
import { createLinuxProcessCollector } from "./process-collector-linux.ts";
import { createDarwinProcessCollector } from "./process-collector-darwin.ts";
import { createDarwinProcessNetCollector } from "./process-net-collector-darwin.ts";
import { darwinGpuCollector } from "./gpu-darwin.ts";
import { darwinProcessDiskIo } from "./process-io-darwin.ts";
import { darwinProcessPath } from "./process-path-darwin.ts";
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
  /** Desktop applications with a live process: app cgroups on Linux, app bundles
   *  on macOS, window-owning executables on Windows. */
  apps: AppCollector | null;
}

export function toMetricsPlatform(p: NodeJS.Platform = process.platform): MetricsPlatform {
  return p === "win32" || p === "darwin" ? p : "linux";
}

export function createPlatformCollectors(platform: MetricsPlatform = toMetricsPlatform()): PlatformCollectors {
  const gpus = createNvidiaGpuCollector();
  switch (platform) {
    case "win32":
      return {
        platform,
        processes: createWindowsProcessCollector(),
        diskNet: null,
        gpus,
        devices: null,
        // The collector the icon route asks, so it serves only what a tick listed.
        apps: (processes) => windowsAppCollector().collect(processes),
      };
    case "darwin":
      return {
        platform,
        // The GPU collector is the one `collectDarwinDevices` defaults to, so the
        // process column and the GPU page are measured from the same read.
        processes: createDarwinProcessCollector(undefined, undefined, {
          net: createDarwinProcessNetCollector(),
          gpu: darwinGpuCollector(),
          diskIo: darwinProcessDiskIo,
          processPath: darwinProcessPath,
          // The index the Services listing fills, so a job's rows are the pids it listed.
          jobKeys: (rows) => launchdJobIndex().keysFor(rows),
        }),
        diskNet: () => collectDarwinDiskNet(),
        gpus,
        devices: (prev) => collectDarwinDevices(prev),
        // The collector the icon route asks, so it serves only what a tick listed.
        apps: (processes) => darwinAppCollector().collect(processes),
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
