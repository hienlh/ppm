/**
 * The Mac's CPU page: inventory from sysctl (real M1 Max values, and a synthetic
 * Intel Mac written from the documented sysctl shapes — there is no Intel Mac to
 * capture from), the power manager's frequency tables from a real `ioreg`
 * capture, and the per-tick extras.
 */
import { describe, expect, test } from "bun:test";
import {
  cachesFromPerfLevels, collectDarwinCpuLive, maxCpuMHz, parseDvfsTable, parsePmgrDvfs,
  readDarwinCpuInfo, readPerfLevels, readPmgrDvfs,
} from "../../../../src/services/system-metrics/cpu-details-darwin.ts";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";
import { darwinFixture, fakeKernel, u64Array } from "./fixtures/darwin-fixture.ts";

const KiB = 1024;
const MiB = 1024 * 1024;
const m1 = () => fakeKernel(darwinFixture("sysctl-m1max.txt"));

/** An Intel Mac (6 cores, 12 threads, 2.6 GHz) as its sysctls read. */
const INTEL = [
  "machdep.cpu.brand_string: Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
  "hw.packages: 1",
  "hw.physicalcpu: 6",
  "hw.logicalcpu: 12",
  "hw.cpufrequency: 2600000000",
  "hw.cpufrequency_max: 2600000000",
  "hw.l1icachesize: 32768",
  "hw.l1dcachesize: 32768",
  "hw.l2cachesize: 262144",
  "hw.l3cachesize: 12582912",
  "kern.hv_support: 1",
  "kern.hv_vmm_present: 0",
].join("\n");
const intel = (extra = "") => fakeKernel(`${INTEL}\n${extra}`, {
  bytes: {
    // Level 0 is memory; L1 and L2 are shared by the two hyperthreads of a core,
    // the L3 by all twelve logical CPUs.
    "hw.cacheconfig": u64Array([12, 2, 2, 12, 0, 0, 0, 0, 0, 0]),
    "hw.cachesize": u64Array([17179869184, 32768, 262144, 12582912, 0, 0, 0, 0, 0, 0]),
  },
});

describe("readDarwinCpuInfo on an M1 Max", () => {
  const info = readDarwinCpuInfo(m1(), 3228)!;

  test("names, sockets and cores as sysctl reports them", () => {
    expect(info.name).toBe("Apple M1 Max");
    expect(info.sockets).toBe(1);
    expect(info.physicalCores).toBe(10);
    expect(info.logicalCores).toBe(10);
  });

  test("the two kinds of core are counted separately", () => {
    expect(info.performanceCores).toBe(8);
    expect(info.efficiencyCores).toBe(2);
  });

  test("caches come from the perf levels, not the top-level sysctls that describe only the E-cores", () => {
    // 8 × (192 + 128) KiB + 2 × (128 + 64) KiB
    expect(info.l1CacheBytes).toBe(8 * 320 * KiB + 2 * 192 * KiB);
    // Two 12 MiB performance-cluster L2s (four cores each) and one 4 MiB.
    expect(info.l2CacheBytes).toBe(2 * 12 * MiB + 4 * MiB);
    expect(info.l3CacheBytes).toBeUndefined();
  });

  test("the hypervisor is Apple's, and this is not itself a VM", () => {
    expect(info.virtualization).toBe("Apple Hypervisor");
    expect(info.isVirtualMachine).toBe(false);
  });

  test("the top clock is the caller's (from the power manager); there is no base clock", () => {
    expect(info.maxMHz).toBe(3228);
    expect(info.baseMHz).toBeUndefined();
  });

  test("nothing Linux-specific is claimed", () => {
    expect(info.freqDriver).toBeUndefined();
    expect(info.freqGovernor).toBeUndefined();
    expect(info.powerPreference).toBeUndefined();
  });

  test("a VM reports itself", () => {
    const vm = fakeKernel(darwinFixture("sysctl-m1max.txt").replace("kern.hv_vmm_present: 0", "kern.hv_vmm_present: 1"));
    expect(readDarwinCpuInfo(vm)!.isVirtualMachine).toBe(true);
  });
});

describe("readDarwinCpuInfo on an Intel Mac", () => {
  const info = readDarwinCpuInfo(intel())!;

  test("caches from hw.cacheconfig: per-core L1 and L2, one shared L3", () => {
    expect(info.l1CacheBytes).toBe(6 * (32 + 32) * KiB);
    expect(info.l2CacheBytes).toBe(6 * 256 * KiB);
    expect(info.l3CacheBytes).toBe(12 * MiB);
  });

  test("no P/E split on a uniform CPU", () => {
    expect(info.performanceCores).toBeUndefined();
    expect(info.efficiencyCores).toBeUndefined();
  });

  test("the nominal clock is the base; a max equal to it says nothing and is dropped", () => {
    expect(info.baseMHz).toBe(2600);
    expect(info.maxMHz).toBeUndefined();
  });

  test("a max above the base is kept", () => {
    const k = fakeKernel(INTEL.replace("hw.cpufrequency_max: 2600000000", "hw.cpufrequency_max: 4500000000"));
    expect(readDarwinCpuInfo(k)!.maxMHz).toBe(4500);
  });

  test("the hypervisor is VT-x", () => {
    expect(info.virtualization).toBe("Intel VT-x");
  });

  test("no hypervisor support is no virtualisation row, not a false one", () => {
    const k = fakeKernel(INTEL.replace("kern.hv_support: 1", "kern.hv_support: 0"));
    expect(readDarwinCpuInfo(k)!.virtualization).toBeUndefined();
  });
});

describe("readDarwinCpuInfo without a kernel", () => {
  test("no kernel — any platform but darwin — is no CPU info", () => {
    expect(readDarwinCpuInfo(null)).toBeUndefined();
  });

  test("a kernel that cannot name the CPU or count its cores is no CPU info", () => {
    expect(readDarwinCpuInfo(fakeKernel("hw.physicalcpu: 10\nhw.logicalcpu: 10"))).toBeUndefined();
    expect(readDarwinCpuInfo(fakeKernel("machdep.cpu.brand_string: X"))).toBeUndefined();
  });
});

describe("perf levels", () => {
  test("every level the kernel lists, in its order", () => {
    expect(readPerfLevels(m1()).map((l) => [l.name, l.physical])).toEqual([["Performance", 8], ["Efficiency", 2]]);
  });

  test("no perf levels on Intel", () => {
    expect(readPerfLevels(intel())).toEqual([]);
  });

  test("a cluster size that does not divide the cores still counts the partial cluster", () => {
    // Three cores, two per L2: two L2 caches, not one and a half.
    expect(cachesFromPerfLevels([{ name: "Performance", physical: 3, logical: 3, l2Bytes: MiB, cpusPerL2: 2 }]).l2).toBe(2 * MiB);
  });
});

describe("the power manager's frequency tables", () => {
  const tables = parsePmgrDvfs(darwinFixture("ioreg-pmgr.xml"))!;

  test("E-cores, P-cores and GPU on a real M1 Max", () => {
    expect(tables.ecpuMHz).toEqual([600, 972, 1332, 1704, 2064]);
    expect(tables.pcpuMHz.at(0)).toBe(600);
    expect(tables.pcpuMHz.at(-1)).toBe(3228);
    expect(tables.pcpuMHz).toHaveLength(15);
    expect(tables.gpuMHz).toEqual([0, 389, 486, 648, 778, 972, 1296]);
  });

  test("the top CPU clock is the fastest state of either kind", () => {
    expect(maxCpuMHz(tables)).toBe(3228);
    expect(maxCpuMHz({ ecpuMHz: [2064], pcpuMHz: [], gpuMHz: [] })).toBe(2064);
    expect(maxCpuMHz(undefined)).toBeUndefined();
  });

  const table = (...freqs: number[]) => {
    const b = new Uint8Array(freqs.length * 8);
    const v = new DataView(b.buffer);
    freqs.forEach((f, i) => { v.setUint32(i * 8, f, true); v.setUint32(i * 8 + 4, 800, true); });
    return b;
  };

  test("a table in Hz and one in kHz read the same, so a core above 4.29 GHz fits", () => {
    expect(parseDvfsTable(table(600_000_000, 3_228_000_000))).toEqual([600, 3228]);
    expect(parseDvfsTable(table(600_000, 4_512_000))).toEqual([600, 4512]);
  });

  test("a table with no plausible clock is not a frequency table", () => {
    // The non-sram CPU tables on an M1 hold values like these.
    expect(parseDvfsTable(table(0, 1, 2, 100))).toEqual([]);
    expect(parseDvfsTable(new Uint8Array(4))).toEqual([]);
    expect(parseDvfsTable(undefined)).toEqual([]);
  });

  test("output that is not the pmgr node yields nothing", () => {
    expect(parsePmgrDvfs("")).toBeUndefined();
    expect(parsePmgrDvfs('<?xml version="1.0"?><plist version="1.0"><array/></plist>')).toBeUndefined();
    expect(parsePmgrDvfs('<plist version="1.0"><array><dict><key>name</key><string>pmgr</string></dict></array></plist>')).toBeUndefined();
  });

  test("the read asks ioreg for the pmgr node alone", async () => {
    const seen: string[][] = [];
    const run = async (argv: string[]): Promise<RunResult> => {
      seen.push(argv);
      return { stdout: darwinFixture("ioreg-pmgr.xml"), stderr: "", code: 0, timedOut: false };
    };
    expect(maxCpuMHz(await readPmgrDvfs(run))).toBe(3228);
    expect(seen).toEqual([["ioreg", "-a", "-r", "-d", "1", "-n", "pmgr"]]);
  });

  test("a failed ioreg is no tables, not an error", async () => {
    const run = async (): Promise<RunResult> => ({ stdout: "", stderr: "boom", code: 1, timedOut: false });
    expect(await readPmgrDvfs(run)).toBeUndefined();
    const throwing = async (): Promise<RunResult> => { throw new Error("spawn failed"); };
    expect(await readPmgrDvfs(throwing)).toBeUndefined();
  });

  test.if(process.platform === "darwin")("this Mac's own tables have a CPU clock", async () => {
    expect(maxCpuMHz(await readPmgrDvfs())).toBeGreaterThan(1000);
  });
});

describe("collectDarwinCpuLive", () => {
  test("threads from the scheduler, handles from the open-file count, the rest from the sensors", () => {
    const k = fakeKernel("kern.num_files: 11967", { load: () => ({ taskCount: 615, threadCount: 6253 }) });
    expect(collectDarwinCpuLive(k, { cpuC: 52.4, cpuPowerW: 3.573, cpuMHz: 2373 })).toEqual({
      threadCount: 6253, handleCount: 11967, tempC: 52.4, powerW: 3.573, currentMHz: 2373,
    });
  });

  test("anything the host did not answer is absent, never 0", () => {
    const out = collectDarwinCpuLive(fakeKernel(""), {});
    expect(out).toEqual({});
    expect(collectDarwinCpuLive(null)).toEqual({});
  });
});
