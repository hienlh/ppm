import { describe, test, expect } from "bun:test";
import {
  parseGpuLines,
  computeGpuPercents,
  pidFromInstanceName,
  memBytesToMB,
  type GpuUsageState,
} from "../../../../src/services/system-metrics/gpu-process-usage-windows.ts";

// Instance names captured from this Win11 host (luid digits kept, they are not secret).
const ENG_3D = "pid_29876_luid_0x00000000_0x0000A1B2_phys_0_eng_0_engtype_3D";
const ENG_COPY = "pid_29876_luid_0x00000000_0x0000A1B2_phys_0_eng_3_engtype_Copy";
const ENG_OTHER_PID = "pid_1234_luid_0x00000000_0x0000A1B2_phys_0_eng_0_engtype_3D";
const ENG_GHOST = "pid_777_luid_0x00000000_0x0000A1B2_phys_0_eng_0_engtype_VideoDecode";
const MEM_0 = "pid_29876_luid_0x00000000_0x0000A1B2_phys_0";
const MEM_1 = "pid_29876_luid_0x00000000_0x0000A1B2_phys_1";

/** Sys100NS clock: 1 s later = +1e7. */
const T0 = 133_000_000_000_000_000;
const SEC = 10_000_000;

const gLine = (name: string, busy: number, ts: number) => `G\t${name}\t${busy}\t${ts}`;
const startedAtOf = (pid: number) => ({ 29876: 5_000, 1234: 6_000 } as Record<number, number>)[pid];

describe("pidFromInstanceName", () => {
  test("takes the pid out of both instance shapes and refuses anything else", () => {
    expect(pidFromInstanceName(ENG_3D)).toBe(29876);
    expect(pidFromInstanceName(MEM_0)).toBe(29876);
    expect(pidFromInstanceName("pid_0_luid_0x0_0x0_phys_0")).toBeNull();
    expect(pidFromInstanceName("_Total")).toBeNull();
    expect(pidFromInstanceName("")).toBeNull();
  });
});

describe("parseGpuLines", () => {
  test("G rows become engine samples on the counter's own clock; M rows sum per pid across adapters", () => {
    const p = parseGpuLines([
      gLine(ENG_3D, 1_000_000, T0),
      gLine(ENG_COPY, 500_000, T0),
      `M\t${MEM_0}\t1073741824`,
      `M\t${MEM_1}\t536870912`,
    ]);
    expect(p.present).toBe(true);
    expect(p.engines).toHaveLength(2);
    expect(p.engines[0]).toEqual({ pid: 29876, engine: ENG_3D, busy100ns: 1_000_000, atSec: T0 / 1e7 });
    expect(p.memBytesByPid.get(29876)).toBe(1_610_612_736);
  });

  test("malformed, short and zero-timestamp rows are skipped without poisoning the rest", () => {
    const p = parseGpuLines([
      "G\tno-pid-here\t1\t2",
      `G\t${ENG_3D}\tnotanumber\t${T0}`,
      `G\t${ENG_3D}\t1\t0`,
      `M\t${MEM_0}`,
      `M\t${MEM_0}\t-5`,
      gLine(ENG_OTHER_PID, 7, T0),
    ]);
    expect(p.engines.map((e) => e.pid)).toEqual([1234]);
    expect(p.memBytesByPid.size).toBe(0);
  });

  test("a tick with neither section reports present:false — that is what 'host cannot measure' means", () => {
    expect(parseGpuLines([]).present).toBe(false);
    expect(parseGpuLines(["D\t1\t2\t3\t4"]).present).toBe(false);
    // An all-idle machine emits no G rows but still emits M rows.
    expect(parseGpuLines([`M\t${MEM_0}\t0`]).present).toBe(true);
  });
});

describe("computeGpuPercents", () => {
  test("first observation of an engine is 0 — a raw counter alone says nothing", () => {
    const { engines } = parseGpuLines([gLine(ENG_3D, 5 * SEC, T0)]);
    const { pctByPid, next } = computeGpuPercents(null, engines, startedAtOf);
    expect(pctByPid.get(29876)).toBe(0);
    expect(next.byKey.size).toBe(1);
  });

  test("two engines of the same pid are rated separately; the busiest one is the pid's figure (Task Manager semantics)", () => {
    // 3D busy for 0.1 s and Copy for 0.05 s over a 1 s counter interval → 10 %, not 15 %:
    // engines run in parallel, so summing would exceed 100 % under mixed load.
    const t1 = parseGpuLines([gLine(ENG_3D, 0, T0), gLine(ENG_COPY, 0, T0)]);
    const s1 = computeGpuPercents(null, t1.engines, startedAtOf);
    const t2 = parseGpuLines([gLine(ENG_3D, 0.1 * SEC, T0 + SEC), gLine(ENG_COPY, 0.05 * SEC, T0 + SEC)]);
    const s2 = computeGpuPercents(s1.next, t2.engines, startedAtOf);
    expect(s2.pctByPid.get(29876)).toBeCloseTo(10, 1);
  });

  test("a pid absent from this tick's process table is dropped, not shown as a ghost row", () => {
    const { engines } = parseGpuLines([gLine(ENG_GHOST, SEC, T0)]);
    const { pctByPid, next } = computeGpuPercents(null, engines, startedAtOf);
    expect(pctByPid.size).toBe(0);
    expect(next.byKey.size).toBe(0);
  });

  test("a recycled pid gets a fresh baseline instead of inheriting the dead process's busy time", () => {
    const t1 = parseGpuLines([gLine(ENG_3D, 9 * SEC, T0)]);
    const s1 = computeGpuPercents(null, t1.engines, () => 5_000);
    const t2 = parseGpuLines([gLine(ENG_3D, 9.5 * SEC, T0 + SEC)]);
    // Same pid and same engine instance, but a later start time → new process.
    const s2 = computeGpuPercents(s1.next, t2.engines, () => 9_000);
    expect(s2.pctByPid.get(29876)).toBe(0);
    // …and the old key is gone, so the map cannot grow without bound.
    expect([...s2.next.byKey.keys()]).toEqual([`${ENG_3D}:9000`]);
  });

  test("a counter going backwards is a provider restart → 0, and it re-baselines", () => {
    const s1 = computeGpuPercents(null, parseGpuLines([gLine(ENG_3D, 9 * SEC, T0)]).engines, startedAtOf);
    const s2 = computeGpuPercents(s1.next, parseGpuLines([gLine(ENG_3D, 1 * SEC, T0 + SEC)]).engines, startedAtOf);
    expect(s2.pctByPid.get(29876)).toBe(0);
    const s3 = computeGpuPercents(s2.next, parseGpuLines([gLine(ENG_3D, 1.2 * SEC, T0 + 2 * SEC)]).engines, startedAtOf);
    expect(s3.pctByPid.get(29876)).toBeCloseTo(20, 1);
  });

  test("the per-pid figure is clamped to 100 even when an engine reports over-full busy", () => {
    const names = [0, 1, 2, 3, 4, 5].map((i) => `pid_29876_luid_0x0_0x0_phys_0_eng_${i}_engtype_3D`);
    const prev: GpuUsageState = { byKey: new Map(names.map((n) => [`${n}:5000`, { inBytes: 0, outBytes: 0, atSec: T0 / 1e7 }])) };
    const { engines } = parseGpuLines(names.map((n) => gLine(n, SEC, T0 + SEC)));
    expect(computeGpuPercents(prev, engines, startedAtOf).pctByPid.get(29876)).toBe(100);
  });

  test("a zero or negative counter interval yields 0 rather than a division blow-up", () => {
    const s1 = computeGpuPercents(null, parseGpuLines([gLine(ENG_3D, 0, T0)]).engines, startedAtOf);
    const same = computeGpuPercents(s1.next, parseGpuLines([gLine(ENG_3D, SEC, T0)]).engines, startedAtOf);
    expect(same.pctByPid.get(29876)).toBe(0);
  });
});

describe("memBytesToMB", () => {
  test("bytes → MB, one decimal", () => {
    expect(memBytesToMB(1073741824)).toBe(1024);
    expect(memBytesToMB(0)).toBe(0);
    expect(memBytesToMB(1_500_000)).toBe(1.4);
  });
});
