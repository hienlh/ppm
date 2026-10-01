/**
 * The Mac's GPU, from real captures of one M1 Max: `ioreg -c IOAccelerator` (the
 * accelerator and its 19 client connections) and `system_profiler
 * SPDisplaysDataType -json`.
 */
import { describe, expect, test } from "bun:test";
import {
  computeDarwinGpuUsage, createDarwinGpuCollector, darwinGpuCollector, matchDisplaysGpu, parseAccelerators,
  parseSpDisplays, readDarwinGpuInventory, readDarwinSpDisplays, toClientState, toDarwinGpuInfo, toDarwinGpuMetrics,
  type DarwinAccelerator, type DarwinGpuClient,
} from "../../../../src/services/system-metrics/gpu-darwin.ts";
import { createDarwinToolReads, type ToolRead } from "../../../../src/services/system-metrics/darwin-tool-reads.ts";
import { parsePlistXml, type PlistValue } from "../../../../src/services/system-metrics/plist-xml.ts";
import type { Runner } from "../../../../src/services/host-info/spawn-runner.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const TREE = parsePlistXml(darwinFixture("ioreg-accelerator.xml"));
const M1_MAX = parseAccelerators(TREE)[0]!;
const SP_DISPLAYS = parseSpDisplays(darwinFixture("sp-displays.json"));
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const gpu = (clients: DarwinGpuClient[]): DarwinAccelerator => ({ id: "agxg13x-0", name: "Apple M1 Max", clients });

/** An accelerator tree as `ioreg` would print it, with WindowServer's one queue. */
const tree = (gpuTimeNs: number): PlistValue => [{
  IOClass: "AGXAcceleratorG13X",
  PerformanceStatistics: { "Device Utilization %": 40 },
  IORegistryEntryChildren: [
    { IOUserClientCreator: "pid 164, WindowServer", IORegistryEntryID: 7, AppUsage: [{ accumulatedGPUTime: gpuTimeNs }] },
  ],
}];

describe("parseAccelerators", () => {
  test("reads the M1 Max's figures and ids it by its driver", () => {
    expect(M1_MAX).toMatchObject({
      id: "agxg13x-0",
      name: "Apple M1 Max",
      vendor: "Apple",
      driver: "AGXG13X",
      driverVersion: "329.2",
      coreCount: 32,
      utilPercent: 81,
      inUseBytes: 1_020_067_840,
    });
    // An Apple GPU has no memory of its own.
    expect(M1_MAX.vramTotalBytes).toBeUndefined();
  });

  test("keeps every client under its registry id, with its queues' GPU time summed", () => {
    expect(M1_MAX.clients).toHaveLength(19);
    // WindowServer holds two connections: one idle, one with four command queues.
    expect(M1_MAX.clients.filter((c) => c.pid === 164)).toEqual([
      { key: "4294970819", pid: 164, gpuTimeNs: 0 },
      { key: "4294970825", pid: 164, gpuTimeNs: 11_899_696_579_374 },
    ]);
  });

  test("a child with no creator, no registry id or no real pid is not a client", () => {
    const [a] = parseAccelerators([{
      IOClass: "AGXAcceleratorG13X",
      IORegistryEntryChildren: [
        { IORegistryEntryID: 1, AppUsage: [{ accumulatedGPUTime: 5 }] },
        { IOUserClientCreator: "pid 9, Example App", AppUsage: [{ accumulatedGPUTime: 5 }] },
        { IOUserClientCreator: "pid 0, kernel_task", IORegistryEntryID: 2 },
        {
          IOUserClientCreator: "pid 12, Example App",
          IORegistryEntryID: 3,
          AppUsage: [{ accumulatedGPUTime: 7 }, { accumulatedGPUTime: 3 }, {}],
        },
      ],
    }]);
    expect(a!.clients).toEqual([{ key: "3", pid: 12, gpuTimeNs: 10 }]);
  });

  test("a node with no model or bundle is named and ided by its class", () => {
    const [bare, amd] = parseAccelerators([
      { IOClass: "IntelAccelerator" },
      {
        IOClass: "AMDRadeonX6000_AMDNavi14GraphicsAccelerator",
        CFBundleIdentifier: "com.apple.kext.AMDRadeonX6000",
        model: "  AMD Radeon Pro 5500M ",
        "vendor-id": new Uint8Array([0x02, 0x10, 0x00, 0x00]),
      },
    ]);
    expect(bare).toEqual({ id: "intelaccelerator-0", name: "IntelAccelerator", clients: [] });
    expect(amd).toMatchObject({ id: "amdradeonx6000-1", name: "AMD Radeon Pro 5500M", vendor: "AMD", driver: "AMDRadeonX6000" });
  });

  test("a utilisation outside 0-100 is clamped", () => {
    const util = (v: number) => parseAccelerators([{ PerformanceStatistics: { "Device Utilization %": v } }])[0]!.utilPercent;
    expect(util(140)).toBe(100);
    expect(util(-3)).toBe(0);
  });

  test("dedicated memory is used + free, and only where the driver publishes both", () => {
    const [both, half] = parseAccelerators([
      { PerformanceStatistics: { vramUsedBytes: GIB, vramFreeBytes: 3 * GIB } },
      { PerformanceStatistics: { vramUsedBytes: GIB } },
    ]);
    expect(both).toMatchObject({ vramUsedBytes: GIB, vramTotalBytes: 4 * GIB });
    expect(half!.vramTotalBytes).toBeUndefined();
  });

  test("anything that is not the list yields no GPUs", () => {
    for (const bad of [undefined, "x", {}, [1, "y"]] as PlistValue[]) expect(parseAccelerators(bad)).toEqual([]);
  });
});

describe("computeDarwinGpuUsage", () => {
  const at10 = toClientState([gpu([
    { key: "a", pid: 164, gpuTimeNs: 1e9 },
    { key: "b", pid: 164, gpuTimeNs: 2e9 },
    { key: "c", pid: 500, gpuTimeNs: 5e9 },
  ])], 10);

  test("the first read has no interval to measure over", () => {
    expect(computeDarwinGpuUsage(null, [M1_MAX], 10).size).toBe(0);
  });

  test("a process's share is its clients' GPU time over the wall interval, summed", () => {
    const usage = computeDarwinGpuUsage(at10, [gpu([
      { key: "a", pid: 164, gpuTimeNs: 1.2e9 },
      { key: "b", pid: 164, gpuTimeNs: 2.3e9 },
      { key: "c", pid: 500, gpuTimeNs: 5e9 },
    ])], 12);
    // (0.2 s + 0.3 s) of GPU time in 2 s.
    expect(usage.get(164)).toBe(25);
    // Measured, and idle: absent, which the table reads as 0.
    expect(usage.has(500)).toBe(false);
  });

  test("a client that was not there last time contributes nothing, however much time it holds", () => {
    const usage = computeDarwinGpuUsage(at10, [gpu([{ key: "new", pid: 700, gpuTimeNs: 80e9 }])], 12);
    expect(usage.has(700)).toBe(false);
  });

  test("a total that went down — a queue closed — contributes nothing", () => {
    const usage = computeDarwinGpuUsage(at10, [gpu([{ key: "c", pid: 500, gpuTimeNs: 1e9 }])], 12);
    expect(usage.has(500)).toBe(false);
  });

  test("clamped at 100 and rounded to one decimal", () => {
    const usage = computeDarwinGpuUsage(at10, [gpu([
      { key: "a", pid: 164, gpuTimeNs: 4e9 },
      { key: "c", pid: 500, gpuTimeNs: 5e9 + (2 / 3) * 1e9 },
    ])], 12);
    expect(usage.get(164)).toBe(100);
    expect(usage.get(500)).toBe(33.3);
  });

  test("no time passed, or the clock went back: nothing is measured", () => {
    const later = [gpu([{ key: "a", pid: 164, gpuTimeNs: 2e9 }])];
    expect(computeDarwinGpuUsage(at10, later, 10).size).toBe(0);
    expect(computeDarwinGpuUsage(at10, later, 9).size).toBe(0);
  });
});

describe("createDarwinGpuCollector", () => {
  test("the table and the page asking in one tick get one read and the same figures", async () => {
    let current: ToolRead<PlistValue> = { value: tree(1e9), atSec: 10 };
    const c = createDarwinGpuCollector(async () => current);
    const table = await c.usage();
    expect(await c.usage()).toBe(table!);
    expect(table!.perProcess.size).toBe(0);

    current = { value: tree(2e9), atSec: 12 };
    const next = await c.usage();
    expect(next!.perProcess.get(164)).toBe(50);
    // The second asker in that tick does not measure over a zero interval.
    expect((await c.usage())!.perProcess.get(164)).toBe(50);
  });

  test("a failed read answers nothing and keeps the baseline", async () => {
    const answers: (ToolRead<PlistValue> | undefined)[] = [
      { value: tree(1e9), atSec: 10 },
      undefined,
      { value: tree(3e9), atSec: 14 },
    ];
    const c = createDarwinGpuCollector(async () => answers.shift());
    await c.usage();
    expect(await c.usage()).toBeUndefined();
    // 2 s of GPU time over the 4 s since the last good read.
    expect((await c.usage())!.perProcess.get(164)).toBe(50);
  });

  test("the process table and the GPU page share one collector", () => {
    expect(darwinGpuCollector()).toBe(darwinGpuCollector());
  });
});

describe("toDarwinGpuMetrics", () => {
  test("an Apple GPU's memory is system memory, drawn against the machine's RAM", () => {
    expect(toDarwinGpuMetrics(M1_MAX, { tempC: 48.5, totalRamBytes: 32 * GIB })).toEqual({
      id: "agxg13x-0",
      name: "Apple M1 Max",
      utilPercent: 81,
      vramUsedMB: 0,
      vramTotalMB: 0,
      sharedUsedMB: 973,
      sharedTotalMB: 32_768,
      tempC: 48.5,
    });
  });

  test("no temperature is attached unless the caller has one", () => {
    expect(toDarwinGpuMetrics(M1_MAX, { totalRamBytes: 32 * GIB })).not.toHaveProperty("tempC");
  });

  test("the clock and the power are the caller's, and absent without them", () => {
    expect(toDarwinGpuMetrics(M1_MAX, { clockMHz: 407, clockMaxMHz: 1296, powerW: 0.401, totalRamBytes: 32 * GIB }))
      .toMatchObject({ clockMHz: 407, clockMaxMHz: 1296, powerW: 0.401 });
    const bare = toDarwinGpuMetrics(M1_MAX, { totalRamBytes: 32 * GIB });
    for (const key of ["clockMHz", "clockMaxMHz", "powerW", "powerMaxW"]) expect(bare).not.toHaveProperty(key);
  });

  test("a GPU that reports no utilisation is not listed at a 0 % nobody read", () => {
    expect(toDarwinGpuMetrics({ id: "intelaccelerator-0", name: "IntelAccelerator", clients: [] })).toBeNull();
  });

  test("a GPU with memory of its own shows that, and no shared figure", () => {
    const m = toDarwinGpuMetrics(
      { ...gpu([]), utilPercent: 10, vramUsedBytes: 512 * MIB, vramTotalBytes: 4 * GIB, inUseBytes: 100 * MIB },
      { totalRamBytes: 32 * GIB },
    );
    expect(m).toMatchObject({ vramUsedMB: 512, vramTotalMB: 4096 });
    expect(m).not.toHaveProperty("sharedUsedMB");
  });
});

describe("parseSpDisplays", () => {
  test("the capture names the M1 Max with its Metal version and core count", () => {
    expect(SP_DISPLAYS).toEqual([{ name: "Apple M1 Max", metalVersion: "Metal 3", coreCount: 32 }]);
  });

  test("a value it does not recognise states no version rather than a guess", () => {
    const [g] = parseSpDisplays(JSON.stringify({
      SPDisplaysDataType: [{ _name: "Intel UHD Graphics 630", spdisplays_mtlgpufamilysupport: "spdisplays_supported" }],
    }));
    expect(g).toEqual({ name: "Intel UHD Graphics 630" });
  });

  test("anything that is not the report yields no GPUs", () => {
    for (const bad of ["", "{", "null", "[]", '{"SPDisplaysDataType":{}}', '{"SPDisplaysDataType":[{},1]}']) {
      expect(parseSpDisplays(bad)).toEqual([]);
    }
  });
});

describe("matchDisplaysGpu", () => {
  test("pairs by name", () => {
    expect(matchDisplaysGpu(M1_MAX, 1, SP_DISPLAYS)).toBe(SP_DISPLAYS[0]!);
  });

  test("one GPU in each list is a pair whatever the two are called", () => {
    const renamed = [{ name: "Apple M1 Max (Built-in)" }];
    expect(matchDisplaysGpu(M1_MAX, 1, renamed)).toBe(renamed[0]!);
  });

  test("with two GPUs, a name that matches nothing pairs with nothing", () => {
    expect(matchDisplaysGpu(M1_MAX, 2, [{ name: "Intel UHD Graphics 630" }, { name: "AMD Radeon Pro 5500M" }]))
      .toBeUndefined();
  });
});

describe("readDarwinGpuInventory", () => {
  const ioreg: Runner = async (argv) => (argv[0] === "ioreg"
    ? { stdout: darwinFixture("ioreg-accelerator.xml"), stderr: "", code: 0, timedOut: false }
    : { stdout: "", stderr: "boom", code: 1, timedOut: false });

  test("keys each GPU like the tick, with the Metal version system_profiler adds", async () => {
    expect(await readDarwinGpuInventory(createDarwinToolReads(ioreg), async () => SP_DISPLAYS)).toEqual([{
      id: "agxg13x-0",
      name: "Apple M1 Max",
      vendor: "Apple",
      driver: "AGXG13X",
      driverVersion: "329.2",
      coreCount: 32,
      metalVersion: "Metal 3",
    }]);
  });

  test("without system_profiler the registry's facts still stand", async () => {
    const [g] = await readDarwinGpuInventory(createDarwinToolReads(ioreg), async () => undefined);
    expect(g).toMatchObject({ id: "agxg13x-0", coreCount: 32 });
    expect(g).not.toHaveProperty("metalVersion");
  });

  test("no ioreg, no GPUs", async () => {
    const fail: Runner = async () => ({ stdout: "", stderr: "boom", code: 1, timedOut: false });
    expect(await readDarwinGpuInventory(createDarwinToolReads(fail), async () => SP_DISPLAYS)).toEqual([]);
  });

  test("system_profiler's core count stands in where the registry has none", () => {
    expect(toDarwinGpuInfo(gpu([]), SP_DISPLAYS[0]).coreCount).toBe(32);
  });
});

describe("readDarwinSpDisplays", () => {
  test("asks system_profiler for JSON, and a failure answers nothing", async () => {
    const calls: string[][] = [];
    const ok: Runner = async (argv) => {
      calls.push(argv);
      return { stdout: darwinFixture("sp-displays.json"), stderr: "", code: 0, timedOut: false };
    };
    expect(await readDarwinSpDisplays(ok)).toEqual(SP_DISPLAYS);
    expect(calls).toEqual([["system_profiler", "SPDisplaysDataType", "-json"]]);

    expect(await readDarwinSpDisplays(async () => ({ stdout: "", stderr: "", code: 1, timedOut: true }))).toBeUndefined();
    expect(await readDarwinSpDisplays(async () => { throw new Error("Executable not found in $PATH"); })).toBeUndefined();
  });
});

describe.if(process.platform === "darwin")("on this Mac", () => {
  test("the accelerator is read live, and a second read measures its clients", async () => {
    let t = 0;
    const reads = createDarwinToolReads(undefined, () => t);
    const c = createDarwinGpuCollector(() => reads.accelerators());
    const first = await c.usage();
    expect(first!.accelerators.length).toBeGreaterThan(0);
    expect(first!.accelerators[0]!.utilPercent).toBeGreaterThanOrEqual(0);
    expect(first!.accelerators[0]!.clients.length).toBeGreaterThan(0);

    t = 2000;
    const second = await c.usage();
    for (const pct of second!.perProcess.values()) {
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  test("system_profiler names this Mac's GPU", async () => {
    const gpus = await readDarwinSpDisplays();
    expect(gpus!.length).toBeGreaterThan(0);
    expect(gpus![0]!.name.length).toBeGreaterThan(0);
  });
});
