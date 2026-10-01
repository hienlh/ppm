/**
 * One tick of every darwin sensor, read together so the device collector asks
 * once: the SMC's temperatures and fans, IOReport's power and clocks, and the
 * internal SSD's NAND temperature. Each source is best-effort — one that throws
 * costs its own figures, never the others' or the tick's.
 *
 * The reads are synchronous FFI calls that wait on the kernel and the SMC's
 * firmware (together about 9 ms a tick on an M1 Max: ≤ 4.7 for the SMC, ~4.2 for
 * IOReport, and the drive's 1.7 once every ten seconds). `collectDarwinDevices`
 * starts them after its tools are spawned, so the wait overlaps theirs.
 */
import type { FanMetrics } from "../../types/system-metrics.ts";
import { readPmgrDvfs, type DvfsTables } from "./cpu-details-darwin.ts";
import { darwinDriveTemperature } from "./hid-temperature-darwin.ts";
import { darwinIoReport, summarizeIoReport, type IoReportSampler } from "./ioreport-darwin.ts";
import { readSmcSensors, type SmcFanReading, type SmcReadings } from "./smc-darwin.ts";

export interface DarwinSensorReadings {
  cpuC?: number;
  gpuC?: number;
  fans: FanMetrics[];
  /** The internal SSD's hottest NAND channel. */
  driveC?: number;
  cpuPowerW?: number;
  cpuMHz?: number;
  gpuPowerW?: number;
  gpuMHz?: number;
  /** The GPU's top clock, from the same frequency table as `gpuMHz`. */
  gpuMaxMHz?: number;
}

export interface DarwinSensorSources {
  smc: () => SmcReadings;
  ioReport: () => IoReportSampler | null;
  drive: () => number | undefined;
  dvfs: () => Promise<DvfsTables | undefined>;
}

const DEFAULT_SOURCES: DarwinSensorSources = {
  smc: () => readSmcSensors(),
  ioReport: darwinIoReport,
  drive: darwinDriveTemperature,
  dvfs: () => readPmgrDvfs(),
};

/**
 * Mission Center's Fan page from the SMC's fans. A Mac numbers its fans and names
 * none of them, so they are "Fan 1", "Fan 2"; it reports no duty cycle and no
 * temperature beside a fan, and those stay absent.
 */
export function toDarwinFanMetrics(fans: readonly SmcFanReading[]): FanMetrics[] {
  return fans.map((fan) => ({
    id: `smc/fan${fan.index}`,
    label: `Fan ${fan.index + 1}`,
    rpm: fan.rpm,
    ...(fan.minRpm !== undefined ? { minRpm: fan.minRpm } : {}),
    ...(fan.maxRpm !== undefined ? { maxRpm: fan.maxRpm } : {}),
  }));
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export async function readDarwinSensors(sources: Partial<DarwinSensorSources> = {}): Promise<DarwinSensorReadings> {
  const { smc, ioReport, drive, dvfs } = { ...DEFAULT_SOURCES, ...sources };
  // Every synchronous read before the first await, so they all run while the
  // tick's child processes do.
  const readings = attempt(smc);
  const delta = attempt(() => ioReport()?.delta());
  const driveC = attempt(drive);
  const tables = await dvfs().catch(() => undefined);
  const figures = delta ? summarizeIoReport(delta, tables) : {};
  const gpuClocks = tables?.gpuMHz.filter((mhz) => mhz > 0) ?? [];

  const out: DarwinSensorReadings = { fans: toDarwinFanMetrics(readings?.fans ?? []) };
  const set = <K extends keyof DarwinSensorReadings>(key: K, value: DarwinSensorReadings[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set("cpuC", readings?.temperatures.cpuC);
  set("gpuC", readings?.temperatures.gpuC);
  set("driveC", driveC);
  set("cpuPowerW", figures.cpuPowerW);
  set("cpuMHz", figures.cpuMHz);
  set("gpuPowerW", figures.gpuPowerW);
  set("gpuMHz", figures.gpuMHz);
  set("gpuMaxMHz", gpuClocks.length > 0 ? Math.max(...gpuClocks) : undefined);
  return out;
}
