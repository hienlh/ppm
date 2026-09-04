import { describe, test, expect } from "bun:test";
import { parsePerfRawDiskNet } from "../../../../src/services/system-metrics/disk-net-collector-windows.ts";
import { toRate } from "../../../../src/services/system-metrics/rate-delta.ts";

// Tagged lines as the in-session query emits them (captured shape from this Win11 host).
const TICK_A = [
  "D\t1000000\t2000000\t50000000000\t10000000",
  "N\tIntel(R) Ethernet Controller I225-V\t500000\t250000\t133000000000000000",
  "N\tTailscale Tunnel\t1000\t2000\t133000000000000000",
  "N\tLoopback Pseudo-Interface 1\t999999\t999999\t133000000000000000",
  "N\tTeredo Tunneling Pseudo-Interface\t5\t5\t133000000000000000",
];
const TICK_B = [
  "D\t1500000\t2400000\t50020000000\t10000000",
  "N\tIntel(R) Ethernet Controller I225-V\t900000\t350000\t133000000020000000",
  "N\tTailscale Tunnel\t3000\t2000\t133000000020000000",
  "N\tLoopback Pseudo-Interface 1\t1999999\t1999999\t133000000020000000",
];

describe("parsePerfRawDiskNet", () => {
  test("disk uses Timestamp_PerfTime / Frequency_PerfTime as its clock", () => {
    const { disk } = parsePerfRawDiskNet(TICK_A);
    expect(disk).toEqual({ inBytes: 1000000, outBytes: 2000000, atSec: 5000 });
  });

  test("net sums real adapters, excludes loopback/Teredo/isatap, clock from Timestamp_Sys100NS", () => {
    const { net } = parsePerfRawDiskNet(TICK_A);
    expect(net).toEqual({ inBytes: 501000, outBytes: 252000, atSec: 133000000000000000 / 1e7 });
  });

  test("two ticks diff into plausible bytes/sec using the counters' own clocks", () => {
    const a = parsePerfRawDiskNet(TICK_A);
    const b = parsePerfRawDiskNet(TICK_B);
    // Disk: Δ 500000 B over Δ 20000000000 / 1e10 = 2 s.
    expect(toRate(a.disk, b.disk!)).toEqual({ inBps: 250000, outBps: 200000, available: true });
    // Net: Δ 402000 B over Δ 20000000 × 100 ns = 2 s.
    expect(toRate(a.net, b.net!)).toEqual({ inBps: 201000, outBps: 50000, available: true });
  });

  test("no counter rows (corrupted perf counters) → null, never zeros", () => {
    expect(parsePerfRawDiskNet([])).toEqual({ disk: null, net: null });
    expect(parsePerfRawDiskNet(["D\t\t\t\t", "N\tX\tabc\t1\t2"])).toEqual({ disk: null, net: null });
  });

  test("zero frequency cannot divide", () => {
    expect(parsePerfRawDiskNet(["D\t1\t2\t3\t0"]).disk).toBeNull();
  });
});
