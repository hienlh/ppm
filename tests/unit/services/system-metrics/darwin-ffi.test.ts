/**
 * The struct layouts behind the macOS memory figures.
 *
 * A wrong offset in a C struct does not fail — it reads the neighbouring field
 * and returns a perfectly plausible page count — so each parser is checked
 * against the tool that prints the same numbers, on bytes captured from a real
 * M1 Max: `host_statistics64` against `vm_stat`, `vm.swapusage` against
 * `sysctl -n vm.swapusage`. The kernel read was taken BETWEEN two `vm_stat`
 * runs, so the fixture carries the drift a live comparison has to tolerate.
 */
import { describe, expect, test } from "bun:test";
import os from "node:os";
import {
  VM_STATISTICS64_BYTES, XSW_USAGE_BYTES, darwinKernel, decodeSysctlNumber, decodeSysctlString,
  parseVmStatistics64, parseXswUsage, type VmStatistics64,
} from "../../../../src/services/system-metrics/darwin-ffi.ts";
import { hexBytes as bytes, vmCapture } from "./fixtures/darwin-fixture.ts";

const capture = vmCapture();

/** `vm_stat`'s own labels for the fields `parseVmStatistics64` reads. */
const VM_STAT_LABEL: Record<keyof VmStatistics64, string> = {
  free: "Pages free",
  active: "Pages active",
  inactive: "Pages inactive",
  speculative: "Pages speculative",
  throttled: "Pages throttled",
  wire: "Pages wired down",
  purgeable: "Pages purgeable",
  external: "File-backed pages",
  internal: "Anonymous pages",
  uncompressedInCompressor: "Pages stored in compressor",
  compressor: "Pages occupied by compressor",
};

function parseVmStat(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.$/.exec(line.trim());
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

describe("parseVmStatistics64 against vm_stat on a real Mac", () => {
  const parsed = parseVmStatistics64(bytes(capture.vmStatistics64Hex))!;
  const before = parseVmStat(capture.vmStatBefore);
  const after = parseVmStat(capture.vmStatAfter);

  test("the capture is the full struct the kernel filled", () => {
    expect(capture.kr).toBe(0);
    expect(capture.count * 4).toBe(VM_STATISTICS64_BYTES);
    expect(parsed).toBeDefined();
  });

  test.each(Object.entries(VM_STAT_LABEL) as [keyof VmStatistics64, string][])(
    "%s is the field vm_stat calls it, not a neighbour",
    (field, label) => {
      const value = parsed[field];
      const expected = after.get(label)!;
      expect(expected).toBeTypeOf("number");
      // Nearest of every figure vm_stat printed: an offset one field off lands
      // on a neighbour and is nearer to THAT one. The drift between the reads
      // is real (the `vm_stat` process itself wires and frees pages), which is
      // why an equality check would be wrong here.
      let nearest = "";
      let best = Infinity;
      for (const [other, n] of after) {
        const d = Math.abs(n - value);
        if (d < best) { best = d; nearest = other; }
      }
      expect(nearest).toBe(label);
      const lo = Math.min(before.get(label)!, expected) - 3000;
      const hi = Math.max(before.get(label)!, expected) + 3000;
      expect(value).toBeGreaterThanOrEqual(lo);
      expect(value).toBeLessThanOrEqual(hi);
    },
  );

  test("the pageable pages are split the same way twice", () => {
    // Anonymous + file-backed covers exactly what active + inactive +
    // speculative covers — a cross-check that holds within ONE read, so it
    // needs no tolerance at all and catches an offset the nearest test cannot.
    expect(parsed.internal + parsed.external).toBe(parsed.active + parsed.inactive + parsed.speculative);
  });

  test("a view into a larger buffer is read from its own offset", () => {
    const whole = new Uint8Array(VM_STATISTICS64_BYTES + 8);
    whole.set(bytes(capture.vmStatistics64Hex), 8);
    expect(parseVmStatistics64(whole.subarray(8))).toEqual(parsed);
  });

  test("a short buffer is not guessed at", () => {
    expect(parseVmStatistics64(new Uint8Array(VM_STATISTICS64_BYTES - 1))).toBeUndefined();
  });
});

describe("parseXswUsage against sysctl vm.swapusage", () => {
  test("total and used are the figures sysctl prints", () => {
    const swap = parseXswUsage(bytes(capture.xswUsageHex))!;
    const m = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(capture.swapusageText)!;
    expect(swap.totalBytes / 2 ** 20).toBeCloseTo(Number(m[1]), 2);
    expect(swap.usedBytes / 2 ** 20).toBeCloseTo(Number(m[2]), 2);
  });

  test("used is read from its own field, not total minus free", () => {
    const b = new Uint8Array(XSW_USAGE_BYTES);
    const v = new DataView(b.buffer);
    v.setBigUint64(0, 1000n, true);
    v.setBigUint64(8, 900n, true); // xsu_avail — deliberately inconsistent
    v.setBigUint64(16, 250n, true);
    expect(parseXswUsage(b)).toEqual({ totalBytes: 1000, usedBytes: 250 });
  });

  test("used above total is clamped: that is a sample taken mid-resize", () => {
    const b = new Uint8Array(XSW_USAGE_BYTES);
    const v = new DataView(b.buffer);
    v.setBigUint64(0, 100n, true);
    v.setBigUint64(16, 150n, true);
    expect(parseXswUsage(b)).toEqual({ totalBytes: 100, usedBytes: 100 });
  });

  test("a short buffer is not guessed at", () => {
    expect(parseXswUsage(new Uint8Array(XSW_USAGE_BYTES - 1))).toBeUndefined();
  });
});

describe("sysctl values", () => {
  test("an int sysctl is 4 bytes and a quad one 8", () => {
    expect(decodeSysctlNumber(bytes(capture.vmPagesizeHex))).toBe(16384);
    expect(decodeSysctlNumber(bytes(capture.hwMemsizeHex))).toBe(34359738368);
    expect(decodeSysctlNumber(bytes(capture.hwMemsizeUsableHex))).toBe(33437024256);
  });

  test("a signed int keeps its sign", () => {
    expect(decodeSysctlNumber(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBe(-1);
  });

  test("any other length is not a number this code can read", () => {
    expect(decodeSysctlNumber(new Uint8Array(2))).toBeUndefined();
    expect(decodeSysctlNumber(new Uint8Array(16))).toBeUndefined();
  });

  test("a string loses its terminator, and an empty one is absent", () => {
    expect(decodeSysctlString(new TextEncoder().encode("Apple M1 Max\0"))).toBe("Apple M1 Max");
    expect(decodeSysctlString(new Uint8Array([0]))).toBeUndefined();
  });
});

describe("the live kernel", () => {
  // This suite runs on Linux in CI and on a Mac by hand; assert the branch that
  // belongs to whichever this is, so the test is meaningful on both.
  const kernel = darwinKernel();

  test("exists on darwin only, so no other platform ever reaches a symbol", () => {
    if (process.platform === "darwin") expect(kernel).not.toBeNull();
    else expect(kernel).toBeNull();
  });

  test.if(process.platform === "darwin")("answers with this machine's own figures", () => {
    const k = kernel!;
    expect(k.sysctlNumber("hw.memsize")).toBe(os.totalmem());
    expect([4096, 16384]).toContain(k.sysctlNumber("vm.pagesize")!);
    expect(k.sysctlString("kern.ostype")).toBe("Darwin");
    expect(k.sysctlNumber("no.such.sysctl")).toBeUndefined();
    expect(k.sysctlBytes("vm.swapusage")?.byteLength).toBe(XSW_USAGE_BYTES);

    const vm = k.vmStatistics()!;
    expect(vm.internal + vm.external).toBe(vm.active + vm.inactive + vm.speculative);
    expect(vm.wire).toBeGreaterThan(0);

    const load = k.processorSetLoad()!;
    expect(load.taskCount).toBeGreaterThan(0);
    expect(load.threadCount).toBeGreaterThanOrEqual(load.taskCount);
  });

  test.if(process.platform === "darwin")("asking again reuses the ports instead of taking new rights", () => {
    // Not observable from here directly; what IS observable is that a second
    // round still answers, i.e. the cached ports stay valid across calls.
    const k = kernel!;
    for (let i = 0; i < 50; i++) {
      expect(k.vmStatistics()).toBeDefined();
      expect(k.processorSetLoad()).toBeDefined();
    }
  });
});
