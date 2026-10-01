/**
 * macOS memory: Activity Monitor's figures from the kernel's page counts, and
 * the `sysctl -n vm.swapusage` parser kept as swap's fallback.
 *
 * The swap half:
 *
 * The reason this exists at all is that the figure was *absent* off Linux, and
 * the memory page renders an absent field as an em dash — the claim that the
 * host's swap cannot be measured. Measured on a real M1 Max, it read
 * `total = 9216.00M  used = 8047.00M`, i.e. 8 GB of swap in use on a machine
 * whose memory page said nothing about swap at all.
 *
 * Both halves of the contract are pinned here: a line that parses yields real
 * numbers, and a line that does not yields `undefined` rather than zeroes —
 * because "0 MB of swap" and "this host's swap was not read" are different
 * claims and the UI draws them differently (a hidden graph against an em dash).
 */
import { describe, test, expect } from "bun:test";
import {
  parseSpMemory, parseSwapUsage, readDarwinMemory, readDarwinMemoryInfo, readSwapUsage, toDarwinMemory,
} from "../../../../src/services/system-metrics/memory-darwin.ts";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";
import {
  parseVmStatistics64, parseXswUsage, type DarwinKernel, type VmStatistics64,
} from "../../../../src/services/system-metrics/darwin-ffi.ts";
import { darwinFixture, hexBytes, vmCapture } from "./fixtures/darwin-fixture.ts";

/** The exact line this host's macOS 15.7.9 printed. */
const REAL = "total = 9216.00M  used = 8047.00M  free = 1169.00M  (encrypted)\n";

describe("the real output", () => {
  test("reads the figures a Mac actually printed", () => {
    expect(parseSwapUsage(REAL)).toEqual({ swapTotalMB: 9216, swapUsedMB: 8047 });
  });

  test("used is taken from `used`, not from total minus free", () => {
    // They agree here, but only because nothing else is mapped; a format change
    // that moved the columns must fail rather than quietly read `free`.
    expect(parseSwapUsage("total = 100.00M  used = 25.00M  free = 75.00M")?.swapUsedMB).toBe(25);
  });
});

describe("units", () => {
  test("G and T scale up, K scales down", () => {
    expect(parseSwapUsage("total = 2.00G used = 1.50G")).toEqual({ swapTotalMB: 2048, swapUsedMB: 1536 });
    expect(parseSwapUsage("total = 1.00T used = 0.50T")).toEqual({ swapTotalMB: 1048576, swapUsedMB: 524288 });
    expect(parseSwapUsage("total = 2048.00K used = 1024.00K")).toEqual({ swapTotalMB: 2, swapUsedMB: 1 });
  });

  test("a bare number is bytes, which only ever matters for zero", () => {
    expect(parseSwapUsage("total = 0 used = 0")).toEqual({ swapTotalMB: 0, swapUsedMB: 0 });
  });
});

describe("swap that is off is zero, not absent", () => {
  test("a Mac with no swap file reports a real 0", () => {
    // The UI hides the graph on `total === 0` and shows an em dash only on
    // `undefined`, so this is the difference between "nothing to swap to" and
    // "not measured".
    expect(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M")).toEqual({
      swapTotalMB: 0, swapUsedMB: 0,
    });
  });
});

describe("anything unrecognised is absent, never zero", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["an error message", "sysctl: unknown oid 'vm.swapusage'"],
    ["only a total", "total = 9216.00M"],
    ["a non-numeric field", "total = N/A used = N/A"],
  ])("%s yields undefined", (_label, input) => {
    expect(parseSwapUsage(input as string | null | undefined)).toBeUndefined();
  });

  test("a negative figure is not trusted into a negative reading", () => {
    expect(parseSwapUsage("total = -1.00M used = 5.00M")).toBeUndefined();
  });
});

describe("used cannot exceed total", () => {
  test("a sample taken mid-resize is clamped, not reported as over-full", () => {
    expect(parseSwapUsage("total = 100.00M used = 150.00M")).toEqual({
      swapTotalMB: 100, swapUsedMB: 100,
    });
  });
});

describe("the reader spawns only where the figure exists", () => {
  test("returns null off darwin, so no other platform pays for a spawn", () => {
    // This suite runs on Linux in CI and on a Mac by hand; assert the branch that
    // belongs to whichever this is, so the test is meaningful on both.
    const out = readSwapUsage();
    if (process.platform === "darwin") {
      expect(out).toBeTypeOf("string");
      expect(parseSwapUsage(out)).toBeDefined();
    } else {
      expect(out).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The page counts: Activity Monitor's figures from `host_statistics64`.     *
 * ------------------------------------------------------------------------ */

const PAGE = 16384;
const GiB = 2 ** 30;
/** Every MB figure in the contract is rounded to one decimal; bytes are exact. */
const mb = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;

/** A `vm_statistics64` in round page counts, so the arithmetic is checkable by eye. */
function vm(over: Partial<VmStatistics64> = {}): VmStatistics64 {
  return {
    free: 1000, active: 0, inactive: 0, wire: 2000, purgeable: 500, speculative: 0,
    compressor: 3000, throttled: 0, external: 4000, internal: 10000,
    uncompressedInCompressor: 7000, ...over,
  };
}

describe("toDarwinMemory", () => {
  const total = 64 * 1024 * PAGE; // 1 GiB of 16 KiB pages: 65536 pages

  test("used is App + Wired + Compressed, with purgeable taken out of App", () => {
    const m = toDarwinMemory(total, { pageSize: PAGE, vm: vm() });
    // (10000 − 500) + 2000 + 3000 pages
    expect(m.inUseBytes).toBe(14500 * PAGE);
    expect(m.usedMB).toBe(mb(14500 * PAGE));
  });

  test("cached is file-backed + purgeable: memory the kernel takes back without asking", () => {
    const m = toDarwinMemory(total, { pageSize: PAGE, vm: vm() });
    expect(m.standbyBytes).toBe(4500 * PAGE);
    expect(m.cachedMB).toBe(mb(4500 * PAGE));
  });

  test("available is cached + free, not total − used", () => {
    // The firmware's reserved pages are in no state; calling them available
    // would promise memory nothing can ever allocate.
    const m = toDarwinMemory(total, { pageSize: PAGE, vm: vm() });
    expect(m.freeBytes).toBe(1000 * PAGE);
    expect(m.availableMB).toBe(mb(5500 * PAGE));
    expect(m.availableMB).toBeLessThan(m.totalMB - m.usedMB);
  });

  test("the headline total is the physical size and the percentage is of it", () => {
    const m = toDarwinMemory(total, { pageSize: PAGE, vm: vm() });
    expect(m.totalMB).toBe(1024);
    expect(m.percent).toBe(Math.round((m.usedMB / 1024) * 1000) / 10);
  });

  test("the compressor is reported as what it occupies and what it saves", () => {
    const m = toDarwinMemory(total, { pageSize: PAGE, vm: vm() });
    expect(m.zramCompressedMB).toBe(mb(3000 * PAGE));
    expect(m.zramSavingsMB).toBe(mb(4000 * PAGE));
  });

  test("an empty compressor is a real zero, not an absent one", () => {
    const m = toDarwinMemory(total, { pageSize: PAGE, vm: vm({ compressor: 0, uncompressedInCompressor: 0 }) });
    expect(m.zramCompressedMB).toBe(0);
    expect(m.zramSavingsMB).toBe(0);
  });

  test("what macOS does not publish stays absent", () => {
    const m = toDarwinMemory(total, { pageSize: PAGE, vm: vm() });
    expect(m.modifiedBytes).toBeUndefined();
    expect(m.committedMB).toBeUndefined();
    expect(m.commitLimitMB).toBeUndefined();
  });

  test("swap comes with the sample, and is absent when the sample has none", () => {
    const withSwap = toDarwinMemory(total, {
      pageSize: PAGE, vm: vm(), swap: { totalBytes: 2 * GiB, usedBytes: GiB / 2 },
    });
    expect(withSwap.swapTotalMB).toBe(2048);
    expect(withSwap.swapUsedMB).toBe(512);
    const without = toDarwinMemory(total, { pageSize: PAGE, vm: vm() });
    expect(without.swapTotalMB).toBeUndefined();
    expect(without.swapUsedMB).toBeUndefined();
  });

  test("purgeable above anonymous never makes App negative", () => {
    const m = toDarwinMemory(total, { pageSize: PAGE, vm: vm({ internal: 100, purgeable: 500 }) });
    expect(m.inUseBytes).toBe((2000 + 3000) * PAGE);
  });

  test("page counts larger than the machine are clamped, never reported above it", () => {
    // A VM whose memsize disagrees with its own page accounting must not draw a
    // bar wider than the machine or a percentage above 100.
    const m = toDarwinMemory(10000 * PAGE, { pageSize: PAGE, vm: vm() });
    expect(m.inUseBytes).toBe(10000 * PAGE);
    expect(m.standbyBytes).toBe(0);
    expect(m.freeBytes).toBe(0);
    expect(m.percent).toBe(100);
  });

  test("the page size is the sample's own: a 4 KiB Intel Mac is not read as 16 KiB", () => {
    const m = toDarwinMemory(total, { pageSize: 4096, vm: vm() });
    expect(m.inUseBytes).toBe(14500 * 4096);
  });
});

describe("toDarwinMemory on a real M1 Max", () => {
  const capture = vmCapture();
  const sample = {
    pageSize: 16384,
    vm: parseVmStatistics64(hexBytes(capture.vmStatistics64Hex))!,
    swap: parseXswUsage(hexBytes(capture.xswUsageHex))!,
  };
  const m = toDarwinMemory(34359738368, sample);

  test("reads as Activity Monitor would have: 26.9 GB used of 32", () => {
    // App 10.68 + Wired 2.90 + Compressed 13.29, computed by hand from vm_stat.
    expect(m.inUseBytes! / GiB).toBeCloseTo(26.87, 2);
    expect(m.totalMB).toBe(32768);
    expect(m.percent).toBeCloseTo(84, 0);
  });

  test("…not 99.7 %, which is what counting only free pages as available gave", () => {
    const freeOnly = 100 - (sample.vm.free * 16384) / 34359738368 * 100;
    expect(freeOnly).toBeGreaterThan(99);
    expect(m.percent).toBeLessThan(freeOnly - 10);
  });

  test("the three parts add up to the usable memory, give or take the kernel's own rounding", () => {
    const parts = m.inUseBytes! + m.standbyBytes! + m.freeBytes!;
    const usable = 33437024256;
    expect(Math.abs(parts - usable) / usable).toBeLessThan(0.001);
  });

  test("swap is the sysctl's own figure", () => {
    expect(m.swapTotalMB).toBe(7168);
    expect(m.swapUsedMB).toBeCloseTo(6039.3, 1);
  });
});

describe("readDarwinMemory", () => {
  const kernel = (over: Partial<DarwinKernel> = {}): DarwinKernel => ({
    sysctlNumber: (name) => (name === "vm.pagesize" ? PAGE : undefined),
    sysctlString: () => undefined,
    sysctlBytes: (name) => {
      if (name !== "vm.swapusage") return undefined;
      const b = new Uint8Array(32);
      const v = new DataView(b.buffer);
      v.setBigUint64(0, BigInt(GiB), true);
      v.setBigUint64(16, BigInt(GiB / 4), true);
      return b;
    },
    vmStatistics: () => vm(),
    processorSetLoad: () => undefined,
    ...over,
  });

  test("no kernel — any platform but darwin — is no sample", () => {
    expect(readDarwinMemory(null)).toBeUndefined();
  });

  test("a full answer is the page counts, the page size and swap", () => {
    expect(readDarwinMemory(kernel())).toEqual({
      pageSize: PAGE, vm: vm(), swap: { totalBytes: GiB, usedBytes: GiB / 4 },
    });
  });

  test("the counts without a page size mean nothing, so there is no sample", () => {
    expect(readDarwinMemory(kernel({ sysctlNumber: () => undefined }))).toBeUndefined();
    expect(readDarwinMemory(kernel({ sysctlNumber: () => 0 }))).toBeUndefined();
  });

  test("a refused page-count read is no sample, so the caller falls back", () => {
    expect(readDarwinMemory(kernel({ vmStatistics: () => undefined }))).toBeUndefined();
  });

  test("a refused swap read leaves swap out rather than failing the rest", () => {
    const sample = readDarwinMemory(kernel({ sysctlBytes: () => undefined }))!;
    expect(sample.vm).toEqual(vm());
    expect(sample.swap).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ *
 * The inventory: `system_profiler SPMemoryDataType -json`.                  *
 * ------------------------------------------------------------------------ */

describe("parseSpMemory", () => {
  test("Apple Silicon: one unified entry — type, maker and size, no slots", () => {
    expect(parseSpMemory(darwinFixture("sp-memory-apple-silicon.json"))).toEqual({
      unified: true,
      devices: [{ locator: "Unified memory", sizeBytes: 32 * GiB, ramType: "LPDDR5", manufacturer: "Hynix" }],
    });
  });

  test("an Intel Mac: every populated slot, and the total counts the empty ones", () => {
    const info = parseSpMemory(darwinFixture("sp-memory-intel-synthetic.json"))!;
    expect(info.unified).toBeUndefined();
    expect(info.slotsTotal).toBe(4);
    expect(info.devices.map((d) => d.locator)).toEqual(["BANK 0/ChannelA-DIMM0", "BANK 2/ChannelB-DIMM0"]);
    expect(info.devices[0]).toEqual({
      locator: "BANK 0/ChannelA-DIMM0", sizeBytes: 16 * GiB, ramType: "DDR4", speedMts: 2667, manufacturer: "SK Hynix",
    });
  });

  test("a JEDEC id is named when it is a common one, and shown as printed otherwise", () => {
    const one = (maker: string) => parseSpMemory(JSON.stringify({
      SPMemoryDataType: [{ _items: [{ _name: "DIMM0", dimm_size: "8 GB", dimm_manufacturer: maker }] }],
    }))!.devices[0]!.manufacturer;
    expect(one("0x80CE")).toBe("Samsung");
    expect(one("0x802c")).toBe("Micron");
    expect(one("0x9999")).toBe("0x9999");
    expect(one("Kingston")).toBe("Kingston");
  });

  test("anything else is no inventory rather than a wrong one", () => {
    expect(parseSpMemory("")).toBeUndefined();
    expect(parseSpMemory("not json")).toBeUndefined();
    expect(parseSpMemory(JSON.stringify({ SPMemoryDataType: [] }))).toBeUndefined();
    expect(parseSpMemory(JSON.stringify({ SPMemoryDataType: [{ dimm_type: "LPDDR5" }] }))).toBeUndefined();
  });
});

describe("readDarwinMemoryInfo", () => {
  const ok = (stdout: string) => async (): Promise<RunResult> => ({ stdout, stderr: "", code: 0, timedOut: false });

  test("asks system_profiler for the memory data type as JSON", async () => {
    const seen: string[][] = [];
    const info = await readDarwinMemoryInfo(async (argv) => {
      seen.push(argv);
      return ok(darwinFixture("sp-memory-apple-silicon.json"))();
    });
    expect(info?.unified).toBe(true);
    expect(seen).toEqual([["system_profiler", "SPMemoryDataType", "-json"]]);
  });

  test("a failed or throwing run is no inventory", async () => {
    expect(await readDarwinMemoryInfo(async () => ({ stdout: "", stderr: "", code: 1, timedOut: false }))).toBeUndefined();
    expect(await readDarwinMemoryInfo(async () => { throw new Error("spawn"); })).toBeUndefined();
  });
});
