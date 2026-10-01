/** Every per-device darwin collector as one tick-shaped call: each drive, each
 *  interface, each GPU and each fan, and the CPU page's live extras — thread and
 *  open-file totals from the kernel, temperature, clock and power from the
 *  sensors. The tools are the shared reads, so the Overview cards and the process
 *  table computed a moment earlier in the same tick cost nothing more here. */
import { collectDarwinCpuLive } from "./cpu-details-darwin.ts";
import { darwinToolReads, type DarwinToolReads } from "./darwin-tool-reads.ts";
import { collectDarwinDiskDevices, parseBlockDevices } from "./disk-devices-darwin.ts";
import { collectDarwinNicDevices, parseIfconfig, parseNetstatLinks, parseServiceOrder } from "./net-devices-darwin.ts";
import { darwinWifiStatus, type DarwinWifiStatus } from "./wifi-darwin.ts";
import { darwinGpuCollector, toDarwinGpuMetrics, type DarwinGpuCollector, type DarwinGpuSensors } from "./gpu-darwin.ts";
import { readDarwinSensors, type DarwinSensorReadings } from "./sensors-darwin.ts";
import type { DeviceCollection, DeviceSampleState } from "./device-collector-types.ts";
import type { CpuMetrics } from "../../types/system-metrics.ts";

export interface DarwinDeviceSources {
  reads: DarwinToolReads;
  wifi: () => DarwinWifiStatus | undefined;
  cpu: (sensors: DarwinSensorReadings) => Partial<CpuMetrics>;
  /** The collector the process table reads too, so both see one `ioreg` a tick. */
  gpu: DarwinGpuCollector;
  sensors: () => Promise<DarwinSensorReadings>;
}

const DEFAULT_SOURCES: DarwinDeviceSources = {
  reads: darwinToolReads(),
  wifi: darwinWifiStatus,
  cpu: (sensors) => collectDarwinCpuLive(undefined, sensors),
  gpu: darwinGpuCollector(),
  sensors: () => readDarwinSensors(),
};

/**
 * A tool that failed this tick costs its list for the tick and keeps its
 * baselines, so the next good read is measured over the longer interval rather
 * than restarting at "measuring…".
 */
export async function collectDarwinDevices(
  prev: DeviceSampleState,
  sources: Partial<DarwinDeviceSources> = {},
): Promise<DeviceCollection> {
  const { reads, wifi, cpu, gpu, sensors } = { ...DEFAULT_SOURCES, ...sources };
  // The sensors last: their reads block the thread for a few milliseconds, and
  // started after the tools they run while those child processes do.
  const [devices, netstat, ifconfig, services, gpuUsage, readings] = await Promise.all([
    reads.blockDevices(), reads.netstat(), reads.ifconfig(), reads.serviceOrder(), gpu.usage(), sensors(),
  ]);

  const disks = devices
    ? collectDarwinDiskDevices(parseBlockDevices(devices.value), devices.atSec, prev.disks, readings.driveC)
    : { disks: [], next: prev.disks };
  const nics = netstat && ifconfig
    ? collectDarwinNicDevices(prev.nics, {
      links: parseNetstatLinks(netstat.value),
      atSec: netstat.atSec,
      ifaces: parseIfconfig(ifconfig.value),
      services: services ? parseServiceOrder(services.value) : undefined,
      wifi: wifi(),
    })
    : { nics: [], next: prev.nics };

  const accelerators = gpuUsage?.accelerators ?? [];
  // Neither the SMC's GPU sensors nor IOReport's GPU channels say which GPU they
  // measure, so they are only attributed where there is one GPU to attribute them
  // to — every Apple Silicon Mac.
  const gpuSensors: DarwinGpuSensors = accelerators.length === 1
    ? { tempC: readings.gpuC, clockMHz: readings.gpuMHz, clockMaxMHz: readings.gpuMaxMHz, powerW: readings.gpuPowerW }
    : {};

  return {
    disks: disks.disks,
    nics: nics.nics,
    fans: readings.fans,
    cpu: cpu(readings),
    gpus: accelerators.flatMap((a) => toDarwinGpuMetrics(a, gpuSensors) ?? []),
    next: { ...prev, disks: disks.next, nics: nics.next },
  };
}
