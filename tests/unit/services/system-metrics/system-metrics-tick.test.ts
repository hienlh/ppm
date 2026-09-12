import { describe, test, expect } from "bun:test";
import { assembleTick, EMPTY_DELTA_STATE, projectLight, type TickDeps } from "../../../../src/services/system-metrics/system-metrics-tick.ts";
import type { CpuTimesSample } from "../../../../src/services/system-metrics/cpu-memory-collector.ts";
import type { ProcessCollector } from "../../../../src/services/system-metrics/process-collector-types.ts";
import { METRICS_INTERVAL_MS, METRICS_LIGHT_INTERVAL_MS } from "../../../../src/types/system-metrics.ts";
import { raw } from "./fixtures/process-fixtures.ts";

// Cumulative counters, like os.cpus(): core 0 has spent `busy` ms of its `at` ms busy.
const cpuSample = (at: number, busy: number): CpuTimesSample => ({
  at, model: "m", times: [
    { user: busy, nice: 0, sys: 0, idle: at - busy, irq: 0, iowait: 0, softirq: 0, steal: 0 },
    { user: 0, nice: 0, sys: 0, idle: at, irq: 0, iowait: 0, softirq: 0, steal: 0 },
  ],
});

function deps(over: Partial<TickDeps> = {}, collector?: Partial<ProcessCollector>) {
  const spawned = { processes: 0, diskNet: 0, gpus: 0 };
  let now = 1000;
  const d: TickDeps = {
    platform: "linux",
    memory: () => ({ totalMB: 1000, usedMB: 400, availableMB: 600, percent: 40 }),
    processes: {
      collect: async () => { spawned.processes++; return { rows: [raw(1, 0, "systemd", { startedAt: 1 }), raw(50, 1, "node", { cpuMs: spawned.processes * 100, startedAt: 5 })], warnings: [] }; },
      stop: () => {},
      ...collector,
    },
    diskNet: async () => { spawned.diskNet++; return { disk: { inBytes: 1000 * spawned.diskNet, outBytes: 0, atSec: spawned.diskNet }, net: null, warnings: ["Network throughput unavailable: test"] }; },
    gpus: { collect: async () => { spawned.gpus++; return [{ name: "G", utilPercent: 1, vramUsedMB: 1, vramTotalMB: 2 }]; }, isDisabled: () => false },
    devices: null,
    apps: null,
    resolveProtected: () => ({ pids: new Set([50]), roots: new Set([50]), selfPid: 50 }),
    now: () => now,
    sampleCpu: (at) => cpuSample(at, (now / 1000) * 100),
    ...over,
  };
  return { d, spawned, advance: (ms: number) => { now += ms; } };
}

describe("assembleTick — light tier", () => {
  test("node:os only: no collector is called, disk/net unavailable, no processes", async () => {
    const { d, spawned } = deps();
    const { snapshot, nextState, guardCtx } = await assembleTick("light", EMPTY_DELTA_STATE, d);
    expect(spawned).toEqual({ processes: 0, diskNet: 0, gpus: 0 });
    expect(snapshot.tier).toBe("light");
    expect(snapshot.intervalMs).toBe(METRICS_LIGHT_INTERVAL_MS);
    expect(snapshot.system.disk.available).toBe(false);
    expect(snapshot.system.gpus).toEqual([]);
    expect(snapshot.system.processCount).toBe(0);
    expect(snapshot.processes).toEqual([]);
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.total).toEqual({ cpu: 0, ramMB: 400, processCount: 0 });
    expect(nextState.cpu).not.toBeNull();
    expect(guardCtx).toBeNull();
    expect(JSON.stringify(snapshot).length).toBeLessThan(2048);
  });

  test("CPU appears from the second tick", async () => {
    const { d, advance } = deps();
    const t1 = await assembleTick("light", EMPTY_DELTA_STATE, d);
    advance(1000);
    const t2 = await assembleTick("light", t1.nextState, d);
    expect(t1.snapshot.system.cpu.total).toBe(0);
    expect(t2.snapshot.system.cpu.total).toBe(5); // 100 busy / 2000 total ticks
    expect(t2.snapshot.system.cpu.cores).toEqual([10, 0]);
  });
});

describe("assembleTick — full tier", () => {
  test("every collector runs once; rates, processes, groups and compat total are filled; state is atomic", async () => {
    const { d, spawned, advance } = deps();
    const t1 = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(spawned).toEqual({ processes: 1, diskNet: 1, gpus: 1 });
    expect(t1.snapshot.system.disk.available).toBe(false); // first sample
    expect(t1.snapshot.warnings).toEqual(["Network throughput unavailable: test"]);
    expect(t1.snapshot.processes.map((p) => p.cpu)).toEqual([0, 0]);

    advance(2000);
    const t2 = await assembleTick("full", t1.nextState, d);
    expect(t2.snapshot.system.disk).toEqual({ inBps: 1000, outBps: 0, available: true });
    expect(t2.snapshot.system.gpus).toHaveLength(1);
    expect(t2.snapshot.system.processCount).toBe(2);
    expect(t2.snapshot.intervalMs).toBe(METRICS_INTERVAL_MS);
    // node gained 100 ms CPU over 2000 ms wall on 2 cores → 2.5 %.
    expect(t2.snapshot.processes.find((p) => p.pid === 50)!.cpu).toBe(2.5);
    expect(t2.snapshot.processes.find((p) => p.pid === 50)!.protected).toBe(true);
    expect(t2.snapshot.groups.find((g) => g.key === "root:50")!.label).toBe("PPM (this server)");
    expect(t2.snapshot.total).toEqual({ cpu: t2.snapshot.system.cpu.total, ramMB: 400, processCount: 2 });
    expect(t2.guardCtx!.protectedPids.has(50)).toBe(true);
  });

  test("a throwing process collector degrades to a warning; CPU/RAM/GPU keep flowing", async () => {
    const { d } = deps({}, { collect: async () => { throw new Error("CIM wedged"); } });
    const { snapshot } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(snapshot.processes).toEqual([]);
    expect(snapshot.warnings.some((w) => w.includes("CIM wedged"))).toBe(true);
    expect(snapshot.system.gpus).toHaveLength(1);
    expect(snapshot.system.mem.totalMB).toBe(1000);
  });

  test("a failed collection keeps the per-process CPU baseline and re-publishes the previous rows", async () => {
    let fail = false;
    const { d, advance } = deps({}, {
      collect: async () => {
        if (fail) throw new Error("busy");
        return { rows: [raw(50, 1, "node", { cpuMs: 100, startedAt: 5 })], warnings: [] };
      },
    });
    const t1 = await assembleTick("full", EMPTY_DELTA_STATE, d);
    advance(2000);
    fail = true;
    const t2 = await assembleTick("full", t1.nextState, d, t1.snapshot);
    // Previous rows/groups shown, warning attached, baseline untouched, no fresh guard ctx.
    expect(t2.snapshot.processes).toEqual(t1.snapshot.processes);
    expect(t2.snapshot.groups).toEqual(t1.snapshot.groups);
    expect(t2.snapshot.system.processCount).toBe(1);
    expect(t2.snapshot.warnings.some((w) => w.includes("busy"))).toBe(true);
    expect(t2.nextState.procCpu).toBe(t1.nextState.procCpu);
    expect(t2.guardCtx).toBeNull();
    // The next good tick still has its baseline: 100 ms → 200 ms over 4 s × 2 cores = 2.5 %.
    advance(2000);
    fail = false;
    d.processes.collect = async () => ({ rows: [raw(50, 1, "node", { cpuMs: 200, startedAt: 5 })], warnings: [] });
    const t3 = await assembleTick("full", t2.nextState, d, t2.snapshot);
    expect(t3.snapshot.processes[0]!.cpu).toBe(1.3);
  });

  test("a duplicate pid in the collected rows is refused with a warning; first row wins", async () => {
    const { d } = deps({}, {
      collect: async () => ({ rows: [raw(7, 1, "lsass", { startedAt: 2 }), raw(7, 1, "notepad", { startedAt: 2 })], warnings: [] }),
    });
    const { snapshot } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(snapshot.processes.map((p) => p.name)).toEqual(["lsass"]);
    expect(snapshot.warnings).toContain('Duplicate row for PID 7 ignored (name "notepad")');
  });

  test("win32 shape: counters ride on the process collection, missing ones warn with the lodctr hint", async () => {
    const { d, spawned } = deps({ platform: "win32", diskNet: null }, {
      collect: async () => ({ rows: [], disk: { inBytes: 1, outBytes: 2, atSec: 3 }, net: null, warnings: [] }),
    });
    const { snapshot, nextState } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(spawned.diskNet).toBe(0);
    expect(nextState.disk).toEqual({ inBytes: 1, outBytes: 2, atSec: 3 });
    expect(nextState.net).toBeNull();
    expect(snapshot.warnings.some((w) => w.includes("lodctr"))).toBe(true);
  });
});

describe("assembleTick — per-process disk/gpu/net columns", () => {
  const collectorWith = (bytes: number, columns?: { disk: boolean; gpu: boolean; net: boolean }) => ({
    collect: async () => ({
      rows: [raw(50, 1, "node", { startedAt: 5, diskReadBytes: bytes, diskWriteBytes: bytes * 2, gpuPct: 12.5, gpuMemMB: 1100 })],
      columns,
      warnings: [],
    }),
    stop: () => {},
  });

  test("the light tier advertises no columns at all", async () => {
    const { d } = deps();
    const { snapshot } = await assembleTick("light", EMPTY_DELTA_STATE, d);
    expect(snapshot.processColumns).toEqual({ disk: false, gpu: false, net: false, swap: false });
  });

  test("processColumns comes from what the collector reported, not from the platform", async () => {
    const { d } = deps({}, collectorWith(0, { disk: true, gpu: true, net: false, swap: false }));
    const { snapshot } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(snapshot.processColumns).toEqual({ disk: true, gpu: true, net: false, swap: false });
  });

  test("a collector that reports no columns yields all-false rather than an absent field", async () => {
    const { d } = deps({}, collectorWith(0));
    const { snapshot } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(snapshot.processColumns).toEqual({ disk: false, gpu: false, net: false, swap: false });
  });

  test("Bps is 0 on a process's first tick and a real rate afterwards; GPU passes through as given", async () => {
    let bytes = 1000;
    const { d, advance } = deps({}, {
      collect: async () => ({
        rows: [raw(50, 1, "node", { startedAt: 5, diskReadBytes: bytes, diskWriteBytes: 0, gpuPct: 12.5, gpuMemMB: 1100 })],
        columns: { disk: true, gpu: true, net: false, swap: false },
        warnings: [],
      }),
      stop: () => {},
    });
    const t1 = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(t1.snapshot.processes[0]!.diskReadBps).toBe(0);
    expect(t1.snapshot.processes[0]!.gpuPct).toBe(12.5);
    expect(t1.snapshot.processes[0]!.gpuMemMB).toBe(1100);

    advance(2000);
    bytes = 5000;
    const t2 = await assembleTick("full", t1.nextState, d);
    // 4000 B over 2 s.
    expect(t2.snapshot.processes[0]!.diskReadBps).toBe(2000);
    expect(t2.snapshot.processes[0]!.diskWriteBps).toBe(0);
    // Group roll-up follows the member.
    expect(t2.snapshot.groups.find((g) => g.pids.includes(50))!.diskReadBps).toBe(2000);
  });

  test("unmeasurable columns are absent from the JSON frame — no nulls to inflate it", async () => {
    // A host that can measure nothing per-process: rows carry no optional field.
    const { d } = deps({}, {
      collect: async () => ({ rows: [raw(50, 1, "node", { startedAt: 5 })], warnings: [] }),
      stop: () => {},
    });
    const { snapshot } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    const row = snapshot.processes[0]!;
    expect(row.diskReadBps).toBeUndefined();
    expect(row.gpuPct).toBeUndefined();
    const json = JSON.stringify(snapshot);
    for (const key of ["diskReadBps", "diskWriteBps", "gpuPct", "gpuMemMB", "netInBps", "netOutBps"]) {
      expect(json).not.toContain(key);
    }
    expect(json).not.toContain("null");
  });

  test("a failed collection re-publishes the previous rows AND the columns they were measured with", async () => {
    let fail = false;
    const { d, advance } = deps({}, {
      collect: async () => {
        if (fail) throw new Error("busy");
        return {
          rows: [raw(50, 1, "node", { startedAt: 5, diskReadBytes: 1 })],
          columns: { disk: true, gpu: true, net: false, swap: false },
          warnings: [],
        };
      },
      stop: () => {},
    });
    const t1 = await assembleTick("full", EMPTY_DELTA_STATE, d);
    advance(2000);
    fail = true;
    const t2 = await assembleTick("full", t1.nextState, d, t1.snapshot);
    expect(t2.snapshot.processColumns).toEqual({ disk: true, gpu: true, net: false, swap: false });
    // The io baseline is kept too, so the next good tick is a real rate.
    expect(t2.nextState.procIo).toBe(t1.nextState.procIo);
  });
});

describe("projectLight", () => {
  test("strips everything the light tier must not carry", () => {
    const full = { tier: "full", system: { disk: { available: true }, net: { available: true }, gpus: [1], processCount: 9, cpu: {}, mem: {} }, groups: [1], processes: [1], total: { cpu: 1, ramMB: 2, processCount: 9 } } as never;
    const light = projectLight(full);
    expect(light.tier).toBe("light");
    expect(light.processes).toEqual([]);
    expect(light.groups).toEqual([]);
    expect(light.system.gpus).toEqual([]);
    expect(light.system.processCount).toBe(0);
    expect(light.system.disk.available).toBe(false);
    expect(light.total.processCount).toBe(0);
    expect(light.processColumns).toEqual({ disk: false, gpu: false, net: false, swap: false });
  });
});

describe("assembleTick — per-device figures", () => {
  const collection = (n: number) => ({
    disks: [{ id: "nvme0n1", available: true, busyPercent: n, responseMs: 0, readBps: 0, writeBps: 0, readTotal: 0, writeTotal: 0 }],
    nics: [{ id: "enp3s0", available: true, rxBps: n, txBps: 0, rxTotal: 0, txTotal: 0, state: "connected" as const }],
    fans: [{ id: "it8689/fan1", label: "Fan 1", rpm: 700 + n }],
    cpu: { currentMHz: 800 + n, tempC: 40, powerW: 7.5 },
    gpus: [{ id: "0000:00:02.0", name: "iGPU", utilPercent: n, vramUsedMB: 0, vramTotalMB: 0 }],
    next: { disks: new Map([["nvme0n1", { atSec: n, readIos: 0, readSectors: 0, readTicks: 0, writeIos: 0, writeSectors: 0, writeTicks: 0, ioTicks: 0, discardIos: 0, discardTicks: 0, flushIos: 0, flushTicks: 0 }]]), nics: new Map(), rapl: null, gpus: new Map() },
  });

  test("the light tier never calls the device collector", async () => {
    let calls = 0;
    const { d } = deps({ devices: () => { calls++; return collection(1); } });
    const { snapshot } = await assembleTick("light", EMPTY_DELTA_STATE, d);
    expect(calls).toBe(0);
    expect(snapshot.system.disks).toBeUndefined();
    expect(snapshot.system.nics).toBeUndefined();
  });

  test("the full tier publishes every list and commits the baseline", async () => {
    const { d } = deps({ devices: () => collection(7) });
    const { snapshot, nextState } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(snapshot.system.disks?.[0]?.busyPercent).toBe(7);
    expect(snapshot.system.nics?.[0]?.rxBps).toBe(7);
    expect(snapshot.system.fans?.[0]?.rpm).toBe(707);
    expect(nextState.devices.disks.get("nvme0n1")?.atSec).toBe(7);
  });

  test("the CPU extras are MERGED over the os.cpus() figures, never replacing them", async () => {
    const { d } = deps({ devices: () => collection(3) });
    const { snapshot } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    // `cores` and `total` come from the cross-platform delta the collector never sees.
    expect(snapshot.system.cpu.cores).toHaveLength(2);
    expect(snapshot.system.cpu.model).toBe("m");
    expect(snapshot.system.cpu).toMatchObject({ currentMHz: 803, tempC: 40, powerW: 7.5 });
  });

  test("sysfs GPUs are APPENDED to the vendor tool's, never replacing them", async () => {
    const { d } = deps({ devices: () => collection(5) });
    const { snapshot } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    // The fixture's gpus collector returns one card; the device collector adds another.
    expect(snapshot.system.gpus.map((g) => g.name)).toEqual(["G", "iGPU"]);
  });

  test("a host with no fans publishes no fan list at all", async () => {
    const { d } = deps({ devices: () => ({ ...collection(1), fans: [] }) });
    const { snapshot } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(snapshot.system.fans).toBeUndefined();
  });

  test("each tick hands the collector the baseline the previous one committed", async () => {
    const seen: (number | undefined)[] = [];
    const { d } = deps({ devices: (prev) => { seen.push(prev.disks.get("nvme0n1")?.atSec); return collection(2); } });
    const first = await assembleTick("full", EMPTY_DELTA_STATE, d);
    await assembleTick("full", first.nextState, d);
    expect(seen).toEqual([undefined, 2]);
  });

  test("a device collector throwing costs the two lists, never the snapshot", async () => {
    const { d } = deps({ devices: () => { throw new Error("sysfs gone"); } });
    const { snapshot, nextState } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect(snapshot.system.disks).toBeUndefined();
    expect(snapshot.system.cpu).toBeDefined();
    expect(snapshot.warnings.some((w) => w.includes("sysfs gone"))).toBe(true);
    // The baseline is untouched, so the next good tick measures from the last one.
    expect(nextState.devices.disks.size).toBe(0);
  });

  test("a host with no device source (win32, macOS) simply omits both", async () => {
    const { d } = deps({ devices: null });
    const { snapshot } = await assembleTick("full", EMPTY_DELTA_STATE, d);
    expect("disks" in snapshot.system).toBe(false);
    expect("nics" in snapshot.system).toBe(false);
  });

  test("projectLight strips the device lists — the status bar must not carry them", () => {
    const full = { system: { disks: [{ id: "a" }], nics: [{ id: "b" }], disk: {}, net: {}, gpus: [], processCount: 3 }, total: {} } as never;
    const light = projectLight(full);
    expect(light.system.disks).toBeUndefined();
    expect(light.system.nics).toBeUndefined();
    expect(JSON.stringify(light).includes('"disks"')).toBe(false);
  });
});
