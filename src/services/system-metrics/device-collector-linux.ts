/** Every per-device Linux collector as one tick-shaped call. */
import { collectLinuxDiskDevices } from "./disk-devices-linux.ts";
import { collectLinuxNicDevices } from "./net-devices-linux.ts";
import { collectLinuxFans } from "./fans-linux.ts";
import { collectCpuLive } from "./cpu-details-linux.ts";
import { collectLinuxGpus } from "./gpu-devices-linux.ts";
import type { DrmGpuCollector } from "./gpu-fdinfo-linux.ts";
import { realLinuxFs, type LinuxFs } from "./linux-fs.ts";
import type { DeviceCollection, DeviceSampleState } from "./device-collector-types.ts";

export function collectLinuxDevices(
  prev: DeviceSampleState,
  drm: DrmGpuCollector,
  fs: LinuxFs = realLinuxFs,
  now: () => number = Date.now,
): DeviceCollection {
  const disks = collectLinuxDiskDevices(prev.disks, fs, now);
  const nics = collectLinuxNicDevices(prev.nics, fs, now);
  const cpu = collectCpuLive(prev.rapl, fs, now);
  // The same walk the process rows are built from: asking here first (or second)
  // costs nothing, because the collector memoises one result per tick.
  const gpus = collectLinuxGpus(prev.gpus, drm.usage(), fs, now);
  return {
    disks: disks.disks,
    nics: nics.nics,
    fans: collectLinuxFans(fs),
    cpu: cpu.extras,
    gpus: gpus.gpus,
    next: { disks: disks.next, nics: nics.next, rapl: cpu.rapl, gpus: gpus.next },
  };
}
