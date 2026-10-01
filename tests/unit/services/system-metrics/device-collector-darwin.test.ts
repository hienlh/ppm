/** The darwin device collector's tick shape: each drive, interface and GPU from
 *  the shared tool reads, each fan from the sensors, plus the CPU page's live
 *  extras. */
import os from "node:os";
import { describe, expect, test } from "bun:test";
import { collectDarwinDevices, type DarwinDeviceSources } from "../../../../src/services/system-metrics/device-collector-darwin.ts";
import { EMPTY_DEVICE_STATE } from "../../../../src/services/system-metrics/device-collector-types.ts";
import { createDarwinToolReads } from "../../../../src/services/system-metrics/darwin-tool-reads.ts";
import { createDarwinGpuCollector } from "../../../../src/services/system-metrics/gpu-darwin.ts";
import { createPlatformCollectors } from "../../../../src/services/system-metrics/system-metrics-platform.ts";
import type { DarwinSensorReadings } from "../../../../src/services/system-metrics/sensors-darwin.ts";
import type { Runner } from "../../../../src/services/host-info/spawn-runner.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

/** `ioreg` answers per class (`-c`), every other tool by its name. */
const ANSWERS: Record<string, string> = {
  IOBlockStorageDevice: darwinFixture("ioreg-block-devices.xml"),
  IOAccelerator: darwinFixture("ioreg-accelerator.xml"),
  netstat: darwinFixture("netstat-ib.txt"),
  ifconfig: darwinFixture("ifconfig-av.txt"),
  networksetup: darwinFixture("networksetup-serviceorder.txt"),
};
const answerKey = (argv: string[]) => (argv[0] === "ioreg" ? argv[argv.indexOf("-c") + 1]! : argv[0]!);

/** One tick of an M1 Max's sensors: the figures IOReport, the SMC and the NAND
 *  sensor gave on the machine the fixtures were captured on. */
const READINGS: DarwinSensorReadings = {
  cpuC: 52.4,
  gpuC: 47.2,
  fans: [{ id: "smc/fan0", label: "Fan 1", rpm: 1204, minRpm: 1200, maxRpm: 5779 }],
  driveC: 34,
  cpuPowerW: 3.573,
  cpuMHz: 2373,
  gpuPowerW: 0.401,
  gpuMHz: 407,
  gpuMaxMHz: 1296,
};

function sources(clock: { now: number }, fail: string[] = [], readings: DarwinSensorReadings = READINGS): Partial<DarwinDeviceSources> {
  const run: Runner = async (argv) => (fail.includes(argv[0]!) || !ANSWERS[answerKey(argv)]
    ? { stdout: "", stderr: "boom", code: 1, timedOut: false }
    : { stdout: ANSWERS[answerKey(argv)]!, stderr: "", code: 0, timedOut: false });
  const reads = createDarwinToolReads(run, () => clock.now);
  return {
    reads,
    wifi: () => ({ interfaceName: "en0", rssiDbm: -52, transmitRateMbps: 866.7, channel: 36, band: 2 }),
    cpu: (sensors) => ({ threadCount: 6253, handleCount: 11967, ...(sensors.cpuC !== undefined ? { tempC: sensors.cpuC } : {}) }),
    gpu: createDarwinGpuCollector(() => reads.accelerators()),
    sensors: async () => readings,
  };
}

describe("collectDarwinDevices", () => {
  test("lists the SSD, the interfaces System Settings shows, the GPU and the fans, with the CPU extras", async () => {
    const out = await collectDarwinDevices(EMPTY_DEVICE_STATE, sources({ now: 1000 }));
    expect(out.cpu).toEqual({ threadCount: 6253, handleCount: 11967, tempC: 52.4 });
    expect(out.disks.map((d) => d.id)).toEqual(["disk0"]);
    expect(out.nics.map((n) => n.id)).toEqual(["en7", "en0", "bridge0", "bridge100", "bridge101", "bridge102", "utun4", "utun5"]);
    expect(out.nics.find((n) => n.id === "en0")).toMatchObject({ state: "connected", linkMbps: 867, signalPercent: 80, frequencyMHz: 5180 });
    expect(out.fans).toEqual(READINGS.fans);
    expect(out.gpus).toEqual([{
      id: "agxg13x-0",
      name: "Apple M1 Max",
      utilPercent: 81,
      vramUsedMB: 0,
      vramTotalMB: 0,
      sharedUsedMB: 973,
      sharedTotalMB: Math.round(os.totalmem() / (1024 * 1024)),
      clockMHz: 407,
      clockMaxMHz: 1296,
      powerW: 0.401,
      tempC: 47.2,
    }]);
  });

  test("the CPU page is handed this tick's readings", async () => {
    const seen: DarwinSensorReadings[] = [];
    await collectDarwinDevices(EMPTY_DEVICE_STATE, {
      ...sources({ now: 1000 }),
      cpu: (sensors) => { seen.push(sensors); return {}; },
    });
    expect(seen).toEqual([READINGS]);
  });

  test("the NAND temperature goes to the built-in SSD", async () => {
    const out = await collectDarwinDevices(EMPTY_DEVICE_STATE, sources({ now: 1000 }));
    expect(out.disks.find((d) => d.id === "disk0")?.tempC).toBe(34);
  });

  test("the GPU sensors are only attributed where there is one GPU to attribute them to", async () => {
    const gpu = (id: string) => ({ id, name: id, utilPercent: 5, clients: [] });
    const out = await collectDarwinDevices(EMPTY_DEVICE_STATE, {
      ...sources({ now: 1000 }),
      gpu: { usage: async () => ({ atSec: 1, accelerators: [gpu("intelaccelerator-0"), gpu("amdradeonx6000-1")], perProcess: new Map() }) },
    });
    expect(out.gpus.map((g) => g.id)).toEqual(["intelaccelerator-0", "amdradeonx6000-1"]);
    for (const g of out.gpus) {
      expect(g.tempC ?? g.clockMHz ?? g.clockMaxMHz ?? g.powerW).toBeUndefined();
    }
  });

  test("a Mac whose sensors answered nothing has no fans and no sensor figures, rather than zeros", async () => {
    const out = await collectDarwinDevices(EMPTY_DEVICE_STATE, sources({ now: 1000 }, [], { fans: [] }));
    expect(out.fans).toEqual([]);
    expect(out.disks[0]).not.toHaveProperty("tempC");
    for (const key of ["tempC", "clockMHz", "clockMaxMHz", "powerW"]) expect(out.gpus[0]).not.toHaveProperty(key);
  });

  test("the first tick measures nothing, the second measures from it", async () => {
    const clock = { now: 1000 };
    const src = sources(clock);
    const first = await collectDarwinDevices(EMPTY_DEVICE_STATE, src);
    expect(first.disks[0]?.available).toBe(false);
    expect(first.next.disks.get("disk0")?.atSec).toBe(1);
    clock.now = 3000;
    const second = await collectDarwinDevices(first.next, src);
    // Same counters two seconds apart: measured, and idle.
    expect(second.disks[0]).toMatchObject({ available: true, readBps: 0, busyPercent: 0 });
    expect(second.nics.every((n) => n.available && n.rxBps === 0)).toBe(true);
  });

  test("a failed tool costs its list for the tick and keeps its baselines", async () => {
    const clock = { now: 1000 };
    const first = await collectDarwinDevices(EMPTY_DEVICE_STATE, sources(clock));
    clock.now = 3000;
    const out = await collectDarwinDevices(first.next, sources(clock, ["ioreg", "netstat"]));
    expect(out.disks).toEqual([]);
    expect(out.nics).toEqual([]);
    expect(out.gpus).toEqual([]);
    expect(out.next.disks).toBe(first.next.disks);
    expect(out.next.nics).toBe(first.next.nics);
  });

  test("the darwin platform wires it, so the Mac's pages get their devices", () => {
    expect(createPlatformCollectors("darwin").devices).toBeFunction();
    expect(createPlatformCollectors("win32").devices).toBeNull();
  });

  test.if(process.platform === "darwin")("on this Mac the lists and the extras are real", async () => {
    const out = await collectDarwinDevices(EMPTY_DEVICE_STATE);
    expect(out.cpu.threadCount).toBeGreaterThan(0);
    expect(out.cpu.handleCount).toBeGreaterThan(0);
    expect(out.disks.length).toBeGreaterThan(0);
    expect(out.nics.length).toBeGreaterThan(0);
    // Every Apple Silicon Mac has its GPU on the SoC.
    if (process.arch === "arm64") expect(out.gpus.length).toBeGreaterThan(0);
    for (const fan of out.fans) expect(fan.id).toMatch(/^smc\/fan\d+$/);
  });
});
