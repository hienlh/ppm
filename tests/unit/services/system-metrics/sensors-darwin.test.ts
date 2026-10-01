/**
 * One tick of every darwin sensor: the SMC's temperatures and fans, IOReport's
 * power and clocks against a real M1 Max delta, and the NAND temperature — each
 * source best-effort on its own.
 */
import { describe, expect, test } from "bun:test";
import type { DvfsTables } from "../../../../src/services/system-metrics/cpu-details-darwin.ts";
import type { IoReportDelta, IoReportSampler } from "../../../../src/services/system-metrics/ioreport-darwin.ts";
import {
  readDarwinSensors, toDarwinFanMetrics, type DarwinSensorSources,
} from "../../../../src/services/system-metrics/sensors-darwin.ts";
import type { SmcReadings } from "../../../../src/services/system-metrics/smc-darwin.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const capture = JSON.parse(darwinFixture("ioreport-delta-m1max.json")) as { tables: DvfsTables; delta: IoReportDelta };

const SMC: SmcReadings = {
  temperatures: { cpuC: 52.4, gpuC: 47.2 },
  fans: [{ index: 0, rpm: 1204, minRpm: 1200, maxRpm: 5779 }],
};
const sampler = (delta: IoReportDelta | undefined): IoReportSampler => ({ delta: () => delta });

function sources(over: Partial<DarwinSensorSources> = {}): DarwinSensorSources {
  return {
    smc: () => SMC,
    ioReport: () => sampler(capture.delta),
    drive: () => 34,
    dvfs: async () => capture.tables,
    ...over,
  };
}

const boom = () => { throw new Error("boom"); };

describe("toDarwinFanMetrics", () => {
  test("numbered from one, as a Mac names none of its fans", () => {
    expect(toDarwinFanMetrics([
      { index: 0, rpm: 1204, minRpm: 1200, maxRpm: 5779 },
      { index: 1, rpm: 0 },
    ])).toEqual([
      { id: "smc/fan0", label: "Fan 1", rpm: 1204, minRpm: 1200, maxRpm: 5779 },
      { id: "smc/fan1", label: "Fan 2", rpm: 0 },
    ]);
  });

  test("no duty cycle and no temperature are made up for it", () => {
    const [fan] = toDarwinFanMetrics([{ index: 0, rpm: 1500 }]);
    for (const key of ["pwmPercent", "tempC", "tempName", "minRpm", "maxRpm"]) expect(fan).not.toHaveProperty(key);
  });
});

describe("readDarwinSensors", () => {
  test("every source's figures in one reading", async () => {
    expect(await readDarwinSensors(sources())).toEqual({
      cpuC: 52.4,
      gpuC: 47.2,
      fans: [{ id: "smc/fan0", label: "Fan 1", rpm: 1204, minRpm: 1200, maxRpm: 5779 }],
      driveC: 34,
      cpuPowerW: 3.573,
      cpuMHz: 2373,
      gpuPowerW: 0.401,
      gpuMHz: 407,
      // The GPU table's top entry; its 0 is the off state.
      gpuMaxMHz: 1296,
    });
  });

  test("the blocking reads all happen before the first wait", () => {
    const calls: string[] = [];
    const pending = readDarwinSensors(sources({
      smc: () => { calls.push("smc"); return SMC; },
      ioReport: () => { calls.push("ioReport"); return sampler(capture.delta); },
      drive: () => { calls.push("drive"); return 34; },
    }));
    // Nothing has been awaited yet: the FFI reads ran while the caller's
    // child processes were starting, not after them.
    expect(calls).toEqual(["smc", "ioReport", "drive"]);
    return pending;
  });

  test("the first tick has temperatures and fans but no power or clock yet", async () => {
    const out = await readDarwinSensors(sources({ ioReport: () => sampler(undefined) }));
    expect(out).toMatchObject({ cpuC: 52.4, driveC: 34, gpuMaxMHz: 1296 });
    for (const key of ["cpuPowerW", "cpuMHz", "gpuPowerW", "gpuMHz"]) expect(out).not.toHaveProperty(key);
  });

  test("a Mac with no IOReport (an Intel one) has no power or clock, and the rest", async () => {
    const out = await readDarwinSensors(sources({ ioReport: () => null }));
    expect(out.cpuC).toBe(52.4);
    expect(out).not.toHaveProperty("cpuPowerW");
  });

  test("without the frequency tables there is power but no clock", async () => {
    const out = await readDarwinSensors(sources({ dvfs: async () => undefined }));
    expect(out).toMatchObject({ cpuPowerW: 3.573, gpuPowerW: 0.401 });
    for (const key of ["cpuMHz", "gpuMHz", "gpuMaxMHz"]) expect(out).not.toHaveProperty(key);
    const rejected = await readDarwinSensors(sources({ dvfs: () => Promise.reject(new Error("ioreg died")) }));
    expect(rejected).toMatchObject({ cpuPowerW: 3.573 });
    expect(rejected).not.toHaveProperty("cpuMHz");
  });

  test("a source that throws costs its own figures, never the others'", async () => {
    const noSmc = await readDarwinSensors(sources({ smc: boom }));
    expect(noSmc.fans).toEqual([]);
    expect(noSmc).not.toHaveProperty("cpuC");
    expect(noSmc).toMatchObject({ cpuPowerW: 3.573, driveC: 34 });

    const noIoReport = await readDarwinSensors(sources({ ioReport: boom }));
    expect(noIoReport).toMatchObject({ cpuC: 52.4, driveC: 34 });
    expect(noIoReport).not.toHaveProperty("cpuPowerW");

    const noSampleDelta = await readDarwinSensors(sources({ ioReport: () => ({ delta: boom }) }));
    expect(noSampleDelta).toMatchObject({ cpuC: 52.4 });
    expect(noSampleDelta).not.toHaveProperty("cpuPowerW");

    const noDrive = await readDarwinSensors(sources({ drive: boom }));
    expect(noDrive).toMatchObject({ cpuC: 52.4, cpuPowerW: 3.573 });
    expect(noDrive).not.toHaveProperty("driveC");
  });

  test("a Mac whose sensors answer nothing is no figures and no fans, never zeros", async () => {
    expect(await readDarwinSensors({
      smc: () => ({ temperatures: {}, fans: [] }),
      ioReport: () => null,
      drive: () => undefined,
      dvfs: async () => undefined,
    })).toEqual({ fans: [] });
  });
});

describe.if(process.platform === "darwin" && process.arch === "arm64")("the sensors on this Mac", () => {
  test("temperatures, fans, power and clocks within what the machine can do", async () => {
    await readDarwinSensors();
    await Bun.sleep(1100);
    const out = await readDarwinSensors();
    expect(out.cpuC).toBeGreaterThan(1);
    expect(out.cpuC).toBeLessThan(130);
    expect(out.cpuPowerW).toBeGreaterThan(0);
    expect(out.cpuPowerW).toBeLessThan(200);
    expect(out.cpuMHz).toBeGreaterThan(0);
    for (const fan of out.fans) {
      expect(fan.id).toMatch(/^smc\/fan\d+$/);
      expect(fan.rpm).toBeGreaterThanOrEqual(0);
    }
    if (out.gpuMHz !== undefined) expect(out.gpuMHz).toBeLessThanOrEqual(out.gpuMaxMHz!);
  });
});
