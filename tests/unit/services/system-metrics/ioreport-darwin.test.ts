/**
 * IOReport's power and clock figures: the pure summary against a real M1 Max
 * delta, the baseline logic against a fake subscription, and one live check.
 */
import { describe, expect, test } from "bun:test";
import {
  activeCycles, createIoReportSampler, darwinIoReport, isWantedChannel, joules, MAX_SAMPLE_GAP_SEC, summarizeIoReport,
  type IoReportChannel, type IoReportDelta, type IoReportSubscription,
} from "../../../../src/services/system-metrics/ioreport-darwin.ts";
import { readPmgrDvfs, type DvfsTables } from "../../../../src/services/system-metrics/cpu-details-darwin.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const capture = JSON.parse(darwinFixture("ioreport-delta-m1max.json")) as { tables: DvfsTables; delta: IoReportDelta };
const TABLES = capture.tables;

const energy = (name: string, value: number, unit = "mJ"): IoReportChannel =>
  ({ group: "Energy Model", subgroup: "", name, unit, value });
const core = (name: string, residencies: number[], idle = "IDLE"): IoReportChannel => ({
  group: "CPU Stats", subgroup: "CPU Core Performance States", name, unit: "24Mticks",
  states: residencies.map((residency, i) => ({ name: i === 0 ? idle : `V${i - 1}`, residency })),
});
const gpu = (residencies: number[]): IoReportChannel => ({
  group: "GPU Stats", subgroup: "GPU Performance States", name: "GPUPH", unit: "24Mticks",
  states: residencies.map((residency, i) => ({ name: i === 0 ? "OFF" : `P${i}`, residency })),
});
const delta = (channels: IoReportChannel[], elapsedSec = 2): IoReportDelta => ({ channels, elapsedSec });

describe("joules", () => {
  test("each unit IOReport uses for energy", () => {
    expect(joules(7162, "mJ")).toBeCloseTo(7.162);
    expect(joules(2_000_000, "uJ")).toBeCloseTo(2);
    expect(joules(804_670_360, "nJ")).toBeCloseTo(0.80467);
    expect(joules(5, " mJ ")).toBeCloseTo(0.005);
  });

  test("a unit it does not know is not guessed at", () => {
    expect(joules(5, "J")).toBeUndefined();
    expect(joules(5, "24Mticks")).toBeUndefined();
  });
});

describe("isWantedChannel", () => {
  test("the CPU and GPU energy, per-core states and the GPU's states", () => {
    expect(isWantedChannel("Energy Model", "", "CPU Energy")).toBe(true);
    expect(isWantedChannel("Energy Model", "", "DIE_1_CPU Energy")).toBe(true);
    expect(isWantedChannel("Energy Model", "", "GPU Energy")).toBe(true);
    expect(isWantedChannel("CPU Stats", "CPU Core Performance States", "PCPU130")).toBe(true);
    expect(isWantedChannel("GPU Stats", "GPU Performance States", "GPUPH")).toBe(true);
  });

  test("not the cluster channels, which the totals already contain", () => {
    expect(isWantedChannel("Energy Model", "", "PACC0_CPU")).toBe(false);
    expect(isWantedChannel("Energy Model", "", "GPU0")).toBe(false);
    expect(isWantedChannel("CPU Stats", "CPU Complex Performance States", "PCPU")).toBe(false);
    expect(isWantedChannel("GPU Stats", "GPU Performance States", "GPU_SRAM")).toBe(false);
    expect(isWantedChannel("SoC Stats", "", "CPU Energy")).toBe(false);
  });
});

describe("activeCycles", () => {
  test("the n-th state after the idle one runs at the n-th clock", () => {
    // 10 ticks idle, 30 at 600 MHz, 10 at 2064 MHz.
    expect(activeCycles(core("ECPU000", [10, 30, 0, 0, 0, 10]).states!, TABLES.ecpuMHz))
      .toEqual({ cycles: 30 * 600 + 10 * 2064, time: 40 });
  });

  test("time in a state the table has no clock for is someone else's table", () => {
    expect(activeCycles(core("ECPU000", [0, 1, 0, 0, 0, 0, 5]).states!, TABLES.ecpuMHz)).toBeUndefined();
  });

  test("states beyond the table are fine while nothing is spent in them", () => {
    // The M1 Max GPU lists P1-P15 but has six clocks; P7-P15 stay at 0.
    const states = gpu([100, 1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]).states!;
    expect(activeCycles(states, TABLES.gpuMHz.filter((f) => f > 0))?.time).toBe(21);
  });

  test("a core idle for the whole interval ran no cycles", () => {
    expect(activeCycles(core("PCPU000", [50, 0, 0]).states!, TABLES.pcpuMHz)).toEqual({ cycles: 0, time: 0 });
  });
});

describe("summarizeIoReport", () => {
  test("a real M1 Max tick", () => {
    expect(summarizeIoReport(capture.delta, TABLES)).toEqual({ cpuPowerW: 3.573, gpuPowerW: 0.401, cpuMHz: 2373, gpuMHz: 407 });
  });

  test("power is the energy over the interval, from each unit", () => {
    expect(summarizeIoReport(delta([energy("CPU Energy", 5000), energy("GPU Energy", 1e9, "nJ")]), TABLES))
      .toEqual({ cpuPowerW: 2.5, gpuPowerW: 0.5 });
  });

  test("an Ultra's CPU is one energy channel per die, summed", () => {
    expect(summarizeIoReport(delta([energy("DIE_0_CPU Energy", 3000), energy("DIE_1_CPU Energy", 1000)]), undefined))
      .toEqual({ cpuPowerW: 2 });
  });

  test("an unknown unit or a counter that went backwards is no figure, not a wrong one", () => {
    expect(summarizeIoReport(delta([energy("CPU Energy", 5000, "kWh"), energy("GPU Energy", -5)]), TABLES)).toEqual({});
  });

  test("the CPU clock weighs each core by how long it ran", () => {
    // An efficiency core busy all interval at 2064 MHz, a performance core 1/4 of it at 3228.
    const out = summarizeIoReport(delta([
      core("ECPU000", [0, 0, 0, 0, 0, 100]),
      core("PCPU000", [75, ...Array(14).fill(0), 25]),
    ]), TABLES);
    expect(out.cpuMHz).toBe(Math.round((100 * 2064 + 25 * 3228) / 125));
  });

  test("a core of a kind the tables do not describe costs the clock, not the rest", () => {
    const out = summarizeIoReport(delta([energy("CPU Energy", 2000), core("ECPU000", [0, 10]), core("MCPU000", [0, 10])]), TABLES);
    expect(out).toEqual({ cpuPowerW: 1 });
  });

  test("the GPU table's 0 MHz entry is the off state, not P1", () => {
    expect(summarizeIoReport(delta([gpu([900, 100])]), TABLES).gpuMHz).toBe(389);
  });

  test("a GPU that was off all interval has no clock", () => {
    expect(summarizeIoReport(delta([gpu([1000, 0])]), TABLES).gpuMHz).toBeUndefined();
  });

  test("without the frequency tables there are no clocks, but there is power", () => {
    expect(summarizeIoReport(capture.delta, undefined)).toEqual({ cpuPowerW: 3.573, gpuPowerW: 0.401 });
  });
});

describe("createIoReportSampler", () => {
  function fakeSubscription(script: bigint[]) {
    const live = new Set<bigint>();
    let next = 0;
    const diffs: [bigint, bigint][] = [];
    const sub: IoReportSubscription = {
      sample() {
        const ref = script[next++] ?? 0n;
        if (ref !== 0n) live.add(ref);
        return ref;
      },
      diff(older, newer) {
        diffs.push([older, newer]);
        return [energy("CPU Energy", Number(newer - older) * 1000)];
      },
      free(ref) {
        if (!live.delete(ref)) throw new Error(`freed ${ref} twice or never took it`);
      },
    };
    return { sub, live, diffs };
  }

  test("the first call is a baseline, the next is measured from it", () => {
    const clock = { ms: 1000 };
    const fake = fakeSubscription([1n, 2n]);
    const sampler = createIoReportSampler(fake.sub, () => clock.ms);
    expect(sampler.delta()).toBeUndefined();
    clock.ms = 3000;
    expect(sampler.delta()).toEqual({ channels: [energy("CPU Energy", 1000)], elapsedSec: 2 });
    // Only the newest sample is still held.
    expect([...fake.live]).toEqual([2n]);
  });

  test("a gap in the ticks starts again rather than averaging over it", () => {
    const clock = { ms: 0 };
    const fake = fakeSubscription([1n, 2n, 3n]);
    const sampler = createIoReportSampler(fake.sub, () => clock.ms);
    sampler.delta();
    clock.ms = (MAX_SAMPLE_GAP_SEC + 1) * 1000;
    expect(sampler.delta()).toBeUndefined();
    clock.ms += 2000;
    expect(sampler.delta()?.elapsedSec).toBe(2);
    expect(fake.diffs).toEqual([[2n, 3n]]);
  });

  test("a failed sample keeps the baseline it would have replaced", () => {
    const clock = { ms: 0 };
    const fake = fakeSubscription([1n, 0n, 3n]);
    const sampler = createIoReportSampler(fake.sub, () => clock.ms);
    sampler.delta();
    clock.ms = 2000;
    expect(sampler.delta()).toBeUndefined();
    clock.ms = 4000;
    expect(sampler.delta()?.elapsedSec).toBe(4);
    expect(fake.diffs).toEqual([[1n, 3n]]);
    expect([...fake.live]).toEqual([3n]);
  });

  test("a diff IOReport refuses still frees the older sample", () => {
    const clock = { ms: 0 };
    const fake = fakeSubscription([1n, 2n]);
    fake.sub.diff = () => undefined;
    const sampler = createIoReportSampler(fake.sub, () => clock.ms);
    sampler.delta();
    clock.ms = 2000;
    expect(sampler.delta()).toBeUndefined();
    expect([...fake.live]).toEqual([2n]);
  });
});

describe.if(process.platform === "darwin" && process.arch === "arm64")("IOReport on this Mac", () => {
  test("power and clocks within what the chip can do", async () => {
    const sampler = darwinIoReport();
    expect(sampler).not.toBeNull();
    const tables = await readPmgrDvfs();
    sampler!.delta();
    await Bun.sleep(1000);
    const d = sampler!.delta();
    expect(d).toBeDefined();
    const out = summarizeIoReport(d!, tables);
    expect(out.cpuPowerW).toBeGreaterThan(0);
    expect(out.cpuPowerW).toBeLessThan(200);
    expect(out.gpuPowerW).toBeGreaterThanOrEqual(0);
    if (tables) {
      expect(out.cpuMHz).toBeGreaterThanOrEqual(Math.min(...tables.ecpuMHz, ...tables.pcpuMHz));
      expect(out.cpuMHz).toBeLessThanOrEqual(Math.max(...tables.ecpuMHz, ...tables.pcpuMHz));
    }
  });
});

test.if(process.platform !== "darwin")("off darwin there is nothing to subscribe to", () => {
  expect(darwinIoReport()).toBeNull();
});
