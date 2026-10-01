/**
 * The CPU, Memory, Network, GPU and Fans pages on macOS.
 *
 * The contract renders a figure the host cannot measure as an em dash. That is
 * right for "could not be read" and wrong for "does not exist here": macOS has no
 * cpufreq governor and no commit charge, and Apple Silicon has no base clock, no
 * L3 its kernel reports, and no memory slots. Shown, those rows would be a column
 * of permanent dashes that each claim a failed measurement. This pins that they
 * are left out on macOS only, that Linux keeps every row it had, and that the
 * parts macOS does have carry the names a Mac user reads in Activity Monitor.
 */
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CpuInfo, MemoryInfo, NicInfo } from "../../../src/types/system-hardware";
import type {
  CpuMetrics, FanMetrics, GpuInfo, GpuMetrics, MemoryMetrics, MetricsPlatform, NicMetrics,
} from "../../../src/types/system-metrics";
// No mock of useIsMobile: a server render reads its server snapshot (desktop), and
// bun's mock.module stays in force for every test file after this one.
import { CpuDetail } from "../../../src/web/components/system/performance/cpu-detail.tsx";
import { MemoryDetail } from "../../../src/web/components/system/performance/memory-detail.tsx";
import { NicDetail } from "../../../src/web/components/system/performance/nic-detail.tsx";
import { GpuDetail } from "../../../src/web/components/system/performance/gpu-detail.tsx";
import { FansDetail } from "../../../src/web/components/system/performance/fans-detail.tsx";

/** Every Stat's label, in order. */
const labels = (html: string) => [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1]);
/** The value rendered under one label. */
const valueOf = (html: string, label: string) =>
  new RegExp(`<dt[^>]*>${label.replace(/[()]/g, "\\$&")}</dt><dd[^>]*>([^<]*)</dd>`).exec(html)?.[1];

const GiB = 1024 ** 3;

const cpu: CpuMetrics = {
  total: 12, cores: [10, 20, 5, 5, 5, 5, 5, 5, 30, 40], model: "Apple M1 Max",
  threadCount: 6220, handleCount: 11778, tempC: 55, uptimeSec: 3600,
};

/** What this M1 Max's inventory actually reports. */
const APPLE_SILICON: CpuInfo = {
  name: "Apple M1 Max", sockets: 1, physicalCores: 10, logicalCores: 10,
  performanceCores: 8, efficiencyCores: 2, maxMHz: 3228,
  virtualization: "Apple Hypervisor", isVirtualMachine: false,
  l1CacheBytes: 2944 * 1024, l2CacheBytes: 28 * 1024 * 1024,
};

const INTEL_MAC: CpuInfo = {
  name: "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz", sockets: 1, physicalCores: 8, logicalCores: 16,
  baseMHz: 2400, maxMHz: 5000, virtualization: "Intel VT-x", isVirtualMachine: false,
  l1CacheBytes: 512 * 1024, l2CacheBytes: 2 * 1024 * 1024, l3CacheBytes: 16 * 1024 * 1024,
};

const renderCpu = (info: CpuInfo | undefined, platform?: MetricsPlatform, live: CpuMetrics = cpu) =>
  renderToStaticMarkup(<CpuDetail cpu={live} info={info} history={[]} processCount={812} platform={platform} />);

const LINUX_ONLY_CPU = ["Cpufreq driver", "Governor", "Power preference"];

describe("CPU page", () => {
  it("leaves out on Apple Silicon every row the part has no value for", () => {
    const rows = labels(renderCpu(APPLE_SILICON, "darwin"));
    for (const row of [...LINUX_ONLY_CPU, "Base speed", "L3 cache"]) expect(rows).not.toContain(row);
  });

  it("keeps every row Apple Silicon does fill, and the live ones before they are measured", () => {
    const html = renderCpu(APPLE_SILICON, "darwin");
    expect(valueOf(html, "Max speed")).toBe("3.23 GHz");
    expect(valueOf(html, "Virtualisation")).toBe("Apple Hypervisor");
    expect(valueOf(html, "Sockets")).toBe("1");
    expect(valueOf(html, "Logical processors")).toBe("10");
    expect(valueOf(html, "Threads running")).toBe("6220");
    expect(valueOf(html, "Open handles")).toBe("11778");
    expect(valueOf(html, "L1 cache")).toBe("2.9 MB");
    expect(valueOf(html, "L2 cache")).toBe("28 MB");
    // Clock and power need an interval, which the first tick does not have yet:
    // they stay, as a dash.
    expect(valueOf(html, "Speed")).toBe("—");
    expect(valueOf(html, "Power")).toBe("—");
  });

  it("shows the clock and the power IOReport measured", () => {
    const html = renderCpu(APPLE_SILICON, "darwin", { ...cpu, currentMHz: 2373, powerW: 3.573 });
    expect(valueOf(html, "Speed")).toBe("2.37 GHz");
    expect(valueOf(html, "Power")).toBe("3.6 W");
  });

  it("splits the core count into performance and efficiency cores", () => {
    expect(valueOf(renderCpu(APPLE_SILICON, "darwin"), "Cores")).toBe("10 (8P + 2E)");
  });

  it("shows an Intel Mac's base clock and L3, which it does have", () => {
    const html = renderCpu(INTEL_MAC, "darwin");
    expect(valueOf(html, "Base speed")).toBe("2.40 GHz");
    expect(valueOf(html, "L3 cache")).toBe("16 MB");
    expect(valueOf(html, "Cores")).toBe("8");
    for (const row of LINUX_ONLY_CPU) expect(labels(html)).not.toContain(row);
  });

  it("does not show the Linux-only rows while the inventory is still loading", () => {
    const html = renderCpu(undefined, "darwin");
    for (const row of LINUX_ONLY_CPU) expect(labels(html)).not.toContain(row);
    expect(valueOf(html, "Cores")).toBe("—");
  });

  it("keeps every row on Linux, a dash included, exactly as before", () => {
    for (const platform of ["linux", undefined] as const) {
      const html = renderCpu({ ...APPLE_SILICON, performanceCores: undefined, efficiencyCores: undefined }, platform);
      const rows = labels(html);
      for (const row of [...LINUX_ONLY_CPU, "Base speed", "L3 cache"]) expect(rows).toContain(row);
      expect(valueOf(html, "Base speed")).toBe("—");
      expect(valueOf(html, "Governor")).toBe("—");
      expect(valueOf(html, "Cores")).toBe("10");
    }
  });
});

/** Shaped like the real capture: the three parts sum to the usable memory. */
const DARWIN_MEM: MemoryMetrics = {
  totalMB: 32768, usedMB: 27515, availableMB: 4389, percent: 84,
  inUseBytes: 26.87 * GiB, standbyBytes: 4.2 * GiB, freeBytes: 0.08 * GiB,
  cachedMB: 4300, swapTotalMB: 8192, swapUsedMB: 6800,
  zramCompressedMB: 11000, zramSavingsMB: 21000,
};

const LINUX_MEM: MemoryMetrics = {
  totalMB: 64000, usedMB: 21000, availableMB: 43000, percent: 33,
  inUseBytes: 20 * GiB, modifiedBytes: 0.1 * GiB, standbyBytes: 30 * GiB, freeBytes: 12 * GiB,
  cachedMB: 30000, committedMB: 30000, commitLimitMB: 70000, swapTotalMB: 8192, swapUsedMB: 0,
  zramCompressedMB: 500, zramSavingsMB: 1500,
};

const UNIFIED: MemoryInfo = {
  unified: true,
  devices: [{ locator: "Unified memory", sizeBytes: 32 * GiB, ramType: "LPDDR5", manufacturer: "Hynix" }],
};

const SLOTTED: MemoryInfo = {
  slotsTotal: 2,
  devices: [
    { locator: "BANK 0/ChannelA-DIMM0", sizeBytes: 16 * GiB, ramType: "DDR4", speedMts: 2667 },
    { locator: "BANK 2/ChannelB-DIMM0", sizeBytes: 16 * GiB, ramType: "DDR4", speedMts: 2667 },
  ],
};

const renderMem = (mem: MemoryMetrics, info: MemoryInfo | undefined, platform?: MetricsPlatform) =>
  renderToStaticMarkup(<MemoryDetail mem={mem} info={info} history={[]} platform={platform} />);

/** The composition bar names its segments in its aria-label, in order. */
const segmentsOf = (html: string) => /role="img" aria-label="([^"]*)"/.exec(html)?.[1];

describe("Memory page", () => {
  it("draws macOS's three parts, named as Activity Monitor names them", () => {
    const html = renderMem(DARWIN_MEM, UNIFIED, "darwin");
    expect(segmentsOf(html)).toBe("In use, Cached, Free");
    // No dirty-page count on macOS, so no "Modified 0 B" claim either.
    expect(html).not.toContain("Modified");
    expect(html).not.toContain("Standby");
  });

  it("names the compressor for a Mac and has no commit charge to show", () => {
    const html = renderMem(DARWIN_MEM, UNIFIED, "darwin");
    const rows = labels(html);
    expect(rows).not.toContain("Committed");
    expect(valueOf(html, "Compressed")).toBe("10.7 GB");
    expect(valueOf(html, "Compression savings")).toBe("20.5 GB");
    expect(html).not.toContain("zram");
  });

  it("counts no slots in unified memory, and lists the one package", () => {
    const html = renderMem(DARWIN_MEM, UNIFIED, "darwin");
    const rows = labels(html);
    expect(rows).not.toContain("Slots used");
    expect(rows).not.toContain("Maximum capacity");
    expect(html).not.toContain(">Slots</h4>");
    expect(html).toContain("Unified memory");
    expect(html).toContain("Hynix · LPDDR5");
  });

  it("still lists an Intel Mac's slots", () => {
    const html = renderMem(DARWIN_MEM, SLOTTED, "darwin");
    expect(valueOf(html, "Slots used")).toBe("2 of 2");
    expect(html).toContain(">Slots</h4>");
    expect(html).toContain("BANK 0/ChannelA-DIMM0");
  });

  it("keeps Linux's four parts and every row, exactly as before", () => {
    for (const platform of ["linux", undefined] as const) {
      const html = renderMem(LINUX_MEM, undefined, platform);
      expect(segmentsOf(html)).toBe("In use, Modified, Standby, Free");
      const rows = labels(html);
      for (const row of ["Committed", "Compressed (zram)", "Savings (zram)", "Slots used", "Maximum capacity"]) {
        expect(rows).toContain(row);
      }
    }
  });
});

const WIFI: NicMetrics = {
  id: "en0", available: true, rxBps: 1000, txBps: 500, rxTotal: 1, txTotal: 1, state: "connected",
  linkMbps: 286, signalPercent: 100, frequencyMHz: 5180,
};
const WIFI_INFO: NicInfo = { id: "en0", kind: "wireless", deviceName: "Wi-Fi", mac: "00:00:5e:00:53:0b", ipv4: [], ipv6: [] };

const renderNic = (platform?: MetricsPlatform) =>
  renderToStaticMarkup(<NicDetail nic={WIFI} info={WIFI_INFO} history={[]} platform={platform} />);

describe("Network page", () => {
  it("has no driver row on macOS, where no driver has a name to show", () => {
    const html = renderNic("darwin");
    expect(labels(html)).not.toContain("Driver");
    expect(valueOf(html, "Signal")).toBe("100%");
    expect(valueOf(html, "Frequency")).toBe("5.2 GHz");
    expect(valueOf(html, "Maximum bitrate")).toBe("286 Mbps");
    // Withheld by macOS without Location permission: unknown, so a dash.
    expect(valueOf(html, "Network name")).toBe("—");
  });

  it("keeps the driver row on Linux, a dash included", () => {
    for (const platform of ["linux", undefined] as const) {
      expect(valueOf(renderNic(platform), "Driver")).toBe("—");
    }
  });
});

/** What this M1 Max's tick and inventory report. */
const APPLE_GPU: GpuMetrics = {
  id: "agxg13x-0", name: "Apple M1 Max", utilPercent: 81,
  vramUsedMB: 0, vramTotalMB: 0, sharedUsedMB: 973, sharedTotalMB: 32768, tempC: 48,
};
const APPLE_GPU_INFO: GpuInfo = {
  id: "agxg13x-0", name: "Apple M1 Max", vendor: "Apple", driver: "AGXG13X", driverVersion: "329.2",
  coreCount: 32, metalVersion: "Metal 3",
};
const AMD_IN_INTEL_MAC: GpuMetrics = {
  id: "amdradeonx6000-1", name: "AMD Radeon Pro 5500M", utilPercent: 3, vramUsedMB: 512, vramTotalMB: 4096,
};

const renderGpu = (gpu: GpuMetrics, info: GpuInfo | undefined, platform?: MetricsPlatform) =>
  renderToStaticMarkup(<GpuDetail gpu={gpu} info={info} index={0} history={[]} platform={platform} />);

/** Rows only a PCI GPU on Linux has a value for. */
const LINUX_ONLY_GPU = ["Video encode", "Video decode", "Memory clock", "OpenGL", "Vulkan", "PCI bus address", "PCIe link", "PCIe maximum"];

describe("GPU page", () => {
  it("states what macOS does — cores and Metal — and leaves out what a Mac has no value for", () => {
    const html = renderGpu(APPLE_GPU, APPLE_GPU_INFO, "darwin");
    const rows = labels(html);
    for (const row of [...LINUX_ONLY_GPU, "Video memory"]) expect(rows).not.toContain(row);
    expect(valueOf(html, "GPU cores")).toBe("32");
    expect(valueOf(html, "Metal")).toBe("Metal 3");
    expect(valueOf(html, "Vendor")).toBe("Apple");
    expect(valueOf(html, "Driver")).toBe("AGXG13X 329.2");
    // System memory the GPU holds, against the machine's RAM.
    expect(valueOf(html, "Memory usage")).toBe("973 MB / 32.0 GB");
    // No sensor figures on this tick: clock and power stay, as a dash.
    expect(valueOf(html, "Clock")).toBe("—");
    expect(valueOf(html, "Power")).toBe("—");
  });

  it("shows the clock against the top of the GPU's table, and its power", () => {
    const html = renderGpu({ ...APPLE_GPU, clockMHz: 407, clockMaxMHz: 1296, powerW: 0.401, tempC: 47.2 }, APPLE_GPU_INFO, "darwin");
    expect(valueOf(html, "Clock")).toBe("407 MHz / 1296");
    expect(valueOf(html, "Power")).toBe("0.4 W");
  });

  it("keeps the video memory row for a Mac GPU that has memory of its own", () => {
    const html = renderGpu(AMD_IN_INTEL_MAC, undefined, "darwin");
    expect(valueOf(html, "Video memory")).toBe("512 MB / 4.0 GB");
    for (const row of LINUX_ONLY_GPU) expect(labels(html)).not.toContain(row);
  });

  it("keeps every row on Linux, and none of the Mac's", () => {
    for (const platform of ["linux", undefined] as const) {
      const rows = labels(renderGpu(APPLE_GPU, APPLE_GPU_INFO, platform));
      for (const row of [...LINUX_ONLY_GPU, "Video memory"]) expect(rows).toContain(row);
      expect(rows).not.toContain("GPU cores");
      expect(rows).not.toContain("Metal");
    }
  });
});

const MAC_FAN: FanMetrics = { id: "smc/fan0", label: "Fan 1", rpm: 1204, minRpm: 1200, maxRpm: 5779 };
const LINUX_FAN: FanMetrics = { id: "it8689/fan1", label: "CPU fan", rpm: 1450, pwmPercent: 38, tempC: 51, tempName: "CPU" };

const renderFans = (fans: FanMetrics[], platform?: MetricsPlatform) =>
  renderToStaticMarkup(<FansDetail fans={fans} platform={platform} />);

describe("Fans page", () => {
  it("shows the speeds a Mac keeps its fan between, and no duty cycle it cannot read", () => {
    const html = renderFans([MAC_FAN], "darwin");
    expect(valueOf(html, "Minimum")).toBe("1200 RPM");
    expect(valueOf(html, "Maximum")).toBe("5779 RPM");
    expect(labels(html)).not.toContain("Duty cycle");
    expect(labels(html)).not.toContain("Temperature");
    expect(html).toContain("Fan 1");
    expect(html).toContain("1204 RPM");
  });

  it("dashes a limit the controller did not give", () => {
    expect(valueOf(renderFans([{ id: "smc/fan0", label: "Fan 1", rpm: 0 }], "darwin"), "Maximum")).toBe("—");
  });

  it("keeps the duty cycle and the chip's temperature on Linux, and none of the Mac's rows", () => {
    for (const platform of ["linux", undefined] as const) {
      const html = renderFans([LINUX_FAN], platform);
      expect(valueOf(html, "Duty cycle")).toBe("38%");
      expect(labels(html)).toContain("CPU");
      expect(labels(html)).not.toContain("Minimum");
      expect(labels(html)).not.toContain("Maximum");
    }
  });
});
