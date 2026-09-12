/** Shape of the per-device (drive / interface) half of a tick, platform-neutral so
 *  the tick assembler does not import a Linux module to name its own state. */
import type { CpuMetrics, DiskMetrics, FanMetrics, GpuMetrics, NicMetrics } from "../../types/system-metrics.ts";
import type { DiskSampleState } from "./disk-devices-linux.ts";
import type { NicSampleState } from "./net-devices-linux.ts";
import type { RaplSample } from "./cpu-details-linux.ts";
import type { GpuSampleState } from "./gpu-devices-linux.ts";

/** Previous counters, per device id. Each device is measured against its own
 *  baseline, so one appearing mid-session costs one unavailable tick and never a
 *  spike measured from zero. */
export interface DeviceSampleState {
  disks: DiskSampleState;
  nics: NicSampleState;
  /** Cumulative RAPL energy, the baseline package power is measured against. */
  rapl: RaplSample | null;
  /** Per-card rc6 / uncore counters. */
  gpus: GpuSampleState;
}

export const EMPTY_DEVICE_STATE: DeviceSampleState = {
  disks: new Map(), nics: new Map(), rapl: null, gpus: new Map(),
};

export interface DeviceCollection {
  disks: DiskMetrics[];
  nics: NicMetrics[];
  /** Empty where the host has no fan tachometer. */
  fans: FanMetrics[];
  /** Merged over the cross-platform `CpuMetrics` by the tick, never replacing it. */
  cpu: Partial<CpuMetrics>;
  /** Cards this platform reads from sysfs. Appended to whatever the vendor-tool
   *  collector (nvidia-smi) found, which covers the drivers sysfs cannot. */
  gpus: GpuMetrics[];
  next: DeviceSampleState;
}

/** Synchronous by design: every source is a small sysfs read, so there is no
 *  subprocess to await and no reason for the tick to yield. */
export type DeviceCollector = (prev: DeviceSampleState) => DeviceCollection;
