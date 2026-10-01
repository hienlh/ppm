import { describe, test, expect } from "bun:test";
import {
  collectCpuLive, meanCurrentMHz, parseCacheSize, parseCpuinfoTopology, parseHandleCount,
  parseThreadCount, parseUptimeSec, raplWatts, readCacheSizes, readCpuInfo, readPackageTempC,
  readRaplEnergy, virtualizationName,
} from "../../../../src/services/system-metrics/cpu-details-linux.ts";
import { fakeLinuxFs } from "./fixtures/fake-linux-fs.ts";

const block = (n: number, socket: string, cores: number) => [
  `processor\t: ${n}`,
  "model name\t: 12th Gen Intel(R) Core(TM) i9-12900K",
  `physical id\t: ${socket}`,
  `cpu cores\t: ${cores}`,
  "flags\t\t: fpu vme vmx aes",
].join("\n");

describe("parseCpuinfoTopology", () => {
  test("one socket: sockets, physical cores and threads", () => {
    const t = parseCpuinfoTopology([block(0, "0", 16), block(1, "0", 16)].join("\n\n"));
    expect(t).toMatchObject({ sockets: 1, physicalCores: 16, logicalCores: 2 });
    expect(t.name ?? t.model).toBe("12th Gen Intel(R) Core(TM) i9-12900K");
  });

  test("two sockets sum their core counts, and each is counted once", () => {
    const t = parseCpuinfoTopology([block(0, "0", 8), block(1, "0", 8), block(2, "1", 8), block(3, "1", 8)].join("\n\n"));
    expect(t).toMatchObject({ sockets: 2, physicalCores: 16, logicalCores: 4 });
  });

  test("a kernel publishing no topology (ARM, some VMs) falls back to the thread count", () => {
    const t = parseCpuinfoTopology("processor\t: 0\nprocessor\t: 1\n");
    expect(t).toMatchObject({ sockets: 1, physicalCores: 2, logicalCores: 2 });
  });

  test("the hypervisor flag is what says this kernel is virtualised", () => {
    expect(parseCpuinfoTopology("processor\t: 0\nflags\t: fpu hypervisor\n").flags.has("hypervisor")).toBe(true);
    expect(parseCpuinfoTopology("processor\t: 0\nflags\t: fpu vmx\n").flags.has("hypervisor")).toBe(false);
  });
});

describe("virtualizationName", () => {
  test("the vendor's marketing name, or nothing at all", () => {
    expect(virtualizationName(new Set(["vmx"]))).toBe("Intel VT-x");
    expect(virtualizationName(new Set(["svm"]))).toBe("AMD-V");
    expect(virtualizationName(new Set(["fpu"]))).toBeUndefined();
  });
});

describe("parseCacheSize", () => {
  test("sysfs suffixes", () => {
    expect(parseCacheSize("48K")).toBe(49152);
    expect(parseCacheSize("30720K")).toBe(31457280);
    expect(parseCacheSize("16M")).toBe(16777216);
    expect(parseCacheSize("512")).toBe(512);
    expect(parseCacheSize(undefined)).toBeUndefined();
    expect(parseCacheSize("big")).toBeUndefined();
  });
});

describe("readCacheSizes", () => {
  /** Two CPUs sharing one L1d/L1i/L2 pair, and an L3 shared by both. */
  const fs = fakeLinuxFs({
    dirs: {
      "/sys/devices/system/cpu": ["cpu0", "cpu1", "cpufreq", "possible"],
      "/sys/devices/system/cpu/cpu0/cache": ["index0", "index1", "index2", "index3"],
      "/sys/devices/system/cpu/cpu1/cache": ["index0", "index1", "index2", "index3"],
    },
    files: Object.fromEntries([0, 1].flatMap((cpu) => [
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index0/level`, "1"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index0/type`, "Data"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index0/size`, "48K"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index0/shared_cpu_list`, "0-1"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index1/level`, "1"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index1/type`, "Instruction"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index1/size`, "32K"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index1/shared_cpu_list`, "0-1"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index2/level`, "2"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index2/type`, "Unified"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index2/size`, "1280K"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index2/shared_cpu_list`, "0-1"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index3/level`, "3"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index3/type`, "Unified"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index3/size`, "30720K"],
      [`/sys/devices/system/cpu/cpu${cpu}/cache/index3/shared_cpu_list`, "0-1"],
    ])),
  });

  test("a shared cache is counted once, not once per CPU that sees it", () => {
    const c = readCacheSizes(fs);
    expect(c.l1).toBe(49152 + 32768);
    expect(c.l2).toBe(1310720);
    expect(c.l3).toBe(31457280);
  });

  test("L1 data and instruction are one combined figure, as Mission Center shows", () => {
    expect(readCacheSizes(fs).l1).toBe(81920);
  });

  test("no cache topology at all → no figures rather than zeros", () => {
    expect(readCacheSizes(fakeLinuxFs({}))).toEqual({});
  });
});

describe("readCpuInfo", () => {
  const fs = fakeLinuxFs({
    files: {
      "/proc/cpuinfo": [block(0, "0", 16), block(1, "0", 16)].join("\n\n"),
      "/sys/devices/system/cpu/cpu0/cpufreq/base_frequency": "3200000",
      "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq": "5100000",
      "/sys/devices/system/cpu/cpu0/cpufreq/scaling_driver": "intel_pstate",
      "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor": "powersave",
      "/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference": "balance_performance",
    },
  });

  test("kHz is reported as MHz, which is the unit the page labels", () => {
    const info = readCpuInfo(fs)!;
    expect(info.baseMHz).toBe(3200);
    expect(info.maxMHz).toBe(5100);
  });

  test("driver, governor and power preference ride along", () => {
    expect(readCpuInfo(fs)).toMatchObject({
      name: "12th Gen Intel(R) Core(TM) i9-12900K",
      sockets: 1, physicalCores: 16, logicalCores: 2,
      virtualization: "Intel VT-x", isVirtualMachine: false,
      freqDriver: "intel_pstate", freqGovernor: "powersave", powerPreference: "balance_performance",
    });
  });

  test("no /proc/cpuinfo (not Linux) is undefined, not an empty shell", () => {
    expect(readCpuInfo(fakeLinuxFs({}))).toBeUndefined();
  });
});

describe("meanCurrentMHz", () => {
  test("mean over the online cores, in MHz", () => {
    const fs = fakeLinuxFs({
      dirs: { "/sys/devices/system/cpu": ["cpu0", "cpu1", "cpuidle"] },
      files: {
        "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq": "800000",
        "/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq": "1200000",
      },
    });
    expect(meanCurrentMHz(fs)).toBe(1000);
  });

  test("a host with no cpufreq reports no clock rather than 0 MHz", () => {
    expect(meanCurrentMHz(fakeLinuxFs({ dirs: { "/sys/devices/system/cpu": ["cpu0"] } }))).toBeUndefined();
  });
});

describe("readPackageTempC", () => {
  const chips = (names: Record<string, string>) => fakeLinuxFs({
    dirs: { "/sys/class/hwmon": Object.keys(names) },
    files: Object.fromEntries(Object.entries(names).flatMap(([chip, name]) => [
      [`/sys/class/hwmon/${chip}/name`, name],
      [`/sys/class/hwmon/${chip}/temp1_input`, "39000"],
    ])),
  });

  test("coretemp wins over the board's own sensors", () => {
    expect(readPackageTempC(chips({ hwmon0: "acpitz", hwmon5: "coretemp" }))).toBe(39);
  });

  test("an AMD host reads k10temp", () => {
    expect(readPackageTempC(chips({ hwmon0: "k10temp" }))).toBe(39);
  });

  test("no package sensor → no temperature rather than 0 °C", () => {
    expect(readPackageTempC(chips({ hwmon0: "acpitz" }))).toBeUndefined();
  });
});

describe("RAPL power", () => {
  const fs = fakeLinuxFs({
    dirs: { "/sys/class/powercap": ["intel-rapl", "intel-rapl:0", "intel-rapl:0:0", "intel-rapl:1"] },
    files: {
      "/sys/class/powercap/intel-rapl:0/name": "package-0",
      "/sys/class/powercap/intel-rapl:0/energy_uj": "1000000",
      "/sys/class/powercap/intel-rapl:1/name": "package-1",
      "/sys/class/powercap/intel-rapl:1/energy_uj": "2000000",
    },
  });

  test("every package domain is summed; sub-domains are not double-counted", () => {
    expect(readRaplEnergy(fs, 10)).toEqual({ microjoules: 3_000_000, atSec: 10 });
  });

  test("watts is the energy delta over the interval", () => {
    expect(raplWatts({ microjoules: 0, atSec: 0 }, { microjoules: 15_000_000, atSec: 2 })).toBe(7.5);
  });

  test("the counter wrapping is one unmeasured tick, never a false spike", () => {
    expect(raplWatts({ microjoules: 9_000_000, atSec: 0 }, { microjoules: 10, atSec: 1 })).toBeUndefined();
  });

  test("no baseline and no RAPL at all both report nothing", () => {
    expect(raplWatts(null, { microjoules: 1, atSec: 1 })).toBeUndefined();
    expect(readRaplEnergy(fakeLinuxFs({}), 1)).toBeNull();
  });
});

describe("kernel-wide counts", () => {
  test("threads is the second half of loadavg's running/total field", () => {
    expect(parseThreadCount("3.21 2.78 2.01 1/2940 3127248")).toBe(2940);
    expect(parseThreadCount("")).toBeUndefined();
  });

  test("handles is the allocated column of file-nr", () => {
    expect(parseHandleCount("96051\t0\t2097152")).toBe(96051);
    expect(parseHandleCount(null)).toBeUndefined();
  });

  test("uptime is rounded to whole seconds", () => {
    expect(parseUptimeSec("56679.15 1196960.38")).toBe(56679);
    expect(parseUptimeSec(null)).toBeUndefined();
  });
});

describe("collectCpuLive", () => {
  test("the first call has no baseline, so it reports no power but seeds one", () => {
    const fs = fakeLinuxFs({
      dirs: { "/sys/class/powercap": ["intel-rapl:0"], "/sys/devices/system/cpu": [] },
      files: {
        "/sys/class/powercap/intel-rapl:0/name": "package-0",
        "/sys/class/powercap/intel-rapl:0/energy_uj": "1000000",
        "/proc/uptime": "100.0 0.0",
      },
    });
    const first = collectCpuLive(null, fs, () => 0);
    expect(first.extras.powerW).toBeUndefined();
    expect(first.extras.uptimeSec).toBe(100);
    const second = collectCpuLive(first.rapl, fs, () => 1000);
    expect(second.extras.powerW).toBe(0);
  });
});
