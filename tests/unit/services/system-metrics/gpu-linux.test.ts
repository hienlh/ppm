import { describe, test, expect } from "bun:test";
import {
  collectDrmClients, computeDrmUsage, parseDrmFdinfo, parseMemoryValue, toEngineState,
  createDrmGpuCollector, DRM_RESCAN_MS,
} from "../../../../src/services/system-metrics/gpu-fdinfo-linux.ts";
import {
  collectLinuxGpus, gpuName, listGpuCards, pcieGen, pcieLink, pickDpmCurrent, pickDpmMax,
  rc6BusyPercent, readGpuInfo, readUncoreEnergy, sharedMemory, utilisation,
} from "../../../../src/services/system-metrics/gpu-devices-linux.ts";
import {
  parseMesaVersion, parseOpenglVersion, parseVulkanVersion, createGpuApiVersionReader,
} from "../../../../src/services/system-metrics/gpu-api-versions.ts";
import { fakeLinuxFs } from "./fixtures/fake-linux-fs.ts";

/** A real i915 fdinfo off this repo's dev host. */
const I915_FDINFO = [
  "pos:\t0", "flags:\t0100002", "mnt_id:\t38", "ino:\t536",
  "drm-driver:\ti915", "drm-client-id:\t1018", "drm-pdev:\t0000:00:02.0",
  "drm-total-system0:\t74920 KiB", "drm-shared-system0:\t0",
  "drm-engine-render:\t1616472 ns", "drm-engine-copy:\t0 ns", "drm-engine-video:\t2605200 ns",
].join("\n");

describe("parseDrmFdinfo", () => {
  test("driver, client id, engines and memory off a real i915 fd", () => {
    const c = parseDrmFdinfo(I915_FDINFO, 99)!;
    expect(c).toMatchObject({ pdev: "0000:00:02.0", clientId: "1018", driver: "i915", pid: 99 });
    expect(c.engines.get("render")).toBe(1616472);
    expect(c.engines.get("video")).toBe(2605200);
    expect(c.sharedBytes).toBe(74920 * 1024);
    expect(c.vramBytes).toBe(0);
  });

  test("an fd that is not a DRM fd is null, not an empty client", () => {
    expect(parseDrmFdinfo("pos:\t0\nflags:\t02\n", 1)).toBeNull();
    // A DRM driver line with no client id cannot be deduplicated, so it is dropped.
    expect(parseDrmFdinfo("drm-driver:\ti915\ndrm-pdev:\t0000:00:02.0\n", 1)).toBeNull();
  });

  test("amdgpu's vram regions count as dedicated, gtt as shared", () => {
    const c = parseDrmFdinfo([
      "drm-pdev:\t0000:03:00.0", "drm-client-id:\t7", "drm-driver:\tamdgpu",
      "drm-total-vram0:\t512 MiB", "drm-total-gtt:\t256 MiB",
    ].join("\n"), 5)!;
    expect(c.vramBytes).toBe(512 * 1024 ** 2);
    expect(c.sharedBytes).toBe(256 * 1024 ** 2);
  });

  test("memory units: i915 writes KiB, amdgpu bare bytes", () => {
    expect(parseMemoryValue("74920 KiB")).toBe(76718080);
    expect(parseMemoryValue("512 MiB")).toBe(536870912);
    expect(parseMemoryValue("1 GiB")).toBe(1073741824);
    expect(parseMemoryValue("4096")).toBe(4096);
    expect(parseMemoryValue("n/a")).toBe(0);
  });
});

/** Two threads of one process sharing one client, plus a second process. */
function procFs(clients: { pid: number; fd: string; body: string }[]) {
  const dirs: Record<string, string[]> = { "/proc": [] };
  const files: Record<string, string> = {};
  const links: Record<string, string> = {};
  for (const c of clients) {
    const pid = String(c.pid);
    if (!dirs["/proc"]!.includes(pid)) dirs["/proc"]!.push(pid);
    (dirs[`/proc/${pid}/fd`] ??= []).push(c.fd);
    links[`/proc/${pid}/fd/${c.fd}`] = "/dev/dri/renderD128";
    files[`/proc/${pid}/fdinfo/${c.fd}`] = c.body;
  }
  return fakeLinuxFs({ dirs, files, links });
}

const client = (id: string, render: number, pdev = "0000:00:02.0") =>
  [`drm-pdev:\t${pdev}`, `drm-client-id:\t${id}`, "drm-driver:\ti915",
   `drm-engine-render:\t${render} ns`, "drm-total-system0:\t1024 KiB"].join("\n");

describe("collectDrmClients", () => {
  test("one client dup'd across threads is counted ONCE, not once per fd", () => {
    const fs = procFs([
      { pid: 100, fd: "5", body: client("42", 1000) },
      { pid: 100, fd: "9", body: client("42", 1000) },
      { pid: 200, fd: "3", body: client("42", 1000) },
    ]);
    const found = collectDrmClients(fs);
    expect(found).toHaveLength(1);
    // The lowest pid holding it owns it.
    expect(found[0]?.pid).toBe(100);
  });

  test("only fds pointing into /dev/dri are read at all", () => {
    const fs = fakeLinuxFs({
      dirs: { "/proc": ["7"], "/proc/7/fd": ["1", "2"] },
      links: { "/proc/7/fd/1": "/dev/null", "/proc/7/fd/2": "socket:[123]" },
      files: { "/proc/7/fdinfo/1": client("1", 5), "/proc/7/fdinfo/2": client("2", 5) },
    });
    expect(collectDrmClients(fs)).toEqual([]);
  });

  test("scoping to known pids skips the rest of /proc entirely", () => {
    const fs = procFs([
      { pid: 100, fd: "5", body: client("42", 1000) },
      { pid: 300, fd: "5", body: client("77", 1000) },
    ]);
    expect(collectDrmClients(fs, [300]).map((c) => c.pid)).toEqual([300]);
  });
});

describe("computeDrmUsage", () => {
  test("engine busy is measured against WALL time, per device", () => {
    const prev = toEngineState([{ pdev: "p", clientId: "1", driver: "i915", pid: 1, engines: new Map([["render", 0]]), vramBytes: 0, sharedBytes: 0 }], 0);
    const now = [{ pdev: "p", clientId: "1", driver: "i915", pid: 1, engines: new Map([["render", 5e8]]), vramBytes: 0, sharedBytes: 0 }];
    const u = computeDrmUsage(prev, now, 1);
    expect(u.perDevice.get("p")?.get("render")).toBe(50);
    expect(u.perProcess.get(1)?.gpuPct).toBe(50);
  });

  test("a client that did not exist last tick contributes nothing — no 4000 % spike", () => {
    const u = computeDrmUsage(toEngineState([], 0), [
      { pdev: "p", clientId: "new", driver: "i915", pid: 9, engines: new Map([["render", 9e12]]), vramBytes: 0, sharedBytes: 0 },
    ], 1);
    expect(u.perProcess.get(9)?.gpuPct).toBe(0);
    expect(u.perDevice.get("p")).toBeUndefined();
  });

  test("memory is reported on the first sample — it is an absolute, not a rate", () => {
    const u = computeDrmUsage(null, [
      { pdev: "p", clientId: "1", driver: "i915", pid: 3, engines: new Map(), vramBytes: 0, sharedBytes: 200 * 1024 ** 2 },
    ], 1);
    expect(u.perProcess.get(3)?.sharedMB).toBe(200);
  });

  test("shared memory is summed PER DEVICE, which is all an iGPU page has", () => {
    const u = computeDrmUsage(null, [
      { pdev: "igpu", clientId: "1", driver: "i915", pid: 3, engines: new Map(), vramBytes: 0, sharedBytes: 300 * 1024 ** 2 },
      { pdev: "igpu", clientId: "2", driver: "i915", pid: 4, engines: new Map(), vramBytes: 0, sharedBytes: 200 * 1024 ** 2 },
      { pdev: "card", clientId: "3", driver: "amdgpu", pid: 5, engines: new Map(), vramBytes: 0, sharedBytes: 64 * 1024 ** 2 },
    ], 1);
    expect(u.sharedByDevice.get("igpu")).toBe(500);
    expect(u.sharedByDevice.get("card")).toBe(64);
    // A device nothing is rendering on has no entry, which the page reads as
    // "cannot measure" rather than as 0 bytes.
    expect(u.sharedByDevice.get("absent")).toBeUndefined();
  });

  test("a client holding nothing still registers its device at 0", () => {
    const u = computeDrmUsage(null, [
      { pdev: "igpu", clientId: "1", driver: "i915", pid: 3, engines: new Map(), vramBytes: 0, sharedBytes: 0 },
    ], 1);
    expect(u.sharedByDevice.get("igpu")).toBe(0);
  });

  test("per-device and per-process figures are both capped at 100", () => {
    const prev = toEngineState([{ pdev: "p", clientId: "1", driver: "i915", pid: 1, engines: new Map([["render", 0], ["video", 0]]), vramBytes: 0, sharedBytes: 0 }], 0);
    const u = computeDrmUsage(prev, [
      { pdev: "p", clientId: "1", driver: "i915", pid: 1, engines: new Map([["render", 9e9], ["video", 9e9]]), vramBytes: 0, sharedBytes: 0 },
    ], 1);
    expect(u.perDevice.get("p")?.get("render")).toBe(100);
    expect(u.perProcess.get(1)?.gpuPct).toBe(100);
  });
});

describe("createDrmGpuCollector", () => {
  test("one walk per tick: two callers in the same tick get the same numbers", () => {
    let listCalls = 0;
    const inner = procFs([{ pid: 100, fd: "5", body: client("42", 1000) }]);
    const counting = { ...inner, list: (p: string) => { if (p === "/proc") listCalls++; return inner.list(p); } };
    let clock = 0;
    const c = createDrmGpuCollector(counting, () => clock);
    const a = c.usage();
    const b = c.usage();
    expect(a).toBe(b);
    expect(listCalls).toBe(1);
  });

  test("between full rescans only the known pids are walked", () => {
    let procListings = 0;
    const inner = procFs([{ pid: 100, fd: "5", body: client("42", 1000) }]);
    const counting = { ...inner, list: (p: string) => { if (p === "/proc") procListings++; return inner.list(p); } };
    let clock = 0;
    const c = createDrmGpuCollector(counting, () => clock);
    c.usage();
    for (let i = 1; i <= 4; i++) { clock += 2000; c.usage(); }
    expect(procListings).toBe(1);
    clock += DRM_RESCAN_MS;
    c.usage();
    expect(procListings).toBe(2);
  });
});

describe("listGpuCards", () => {
  const fs = fakeLinuxFs({
    dirs: { "/sys/class/drm": ["card1", "card1-DP-1", "card1-HDMI-A-1", "renderD128", "version"] },
    real: { "/sys/class/drm/card1/device": "/sys/devices/pci0000:00/0000:00:02.0" },
    links: { "/sys/class/drm/card1/device/driver": "../../../../bus/pci/drivers/i915" },
    files: { "/sys/class/drm/card1/device/vendor": "0x8086" },
  });

  test("connectors are not devices; only real cards are listed", () => {
    expect(listGpuCards(fs)).toEqual([{ card: "card1", pdev: "0000:00:02.0", driver: "i915", vendor: "Intel" }]);
  });

  test("a card with no PCI parent (vkms, virtio) is skipped", () => {
    const virt = fakeLinuxFs({
      dirs: { "/sys/class/drm": ["card0"] },
      real: { "/sys/class/drm/card0/device": "/sys/devices/platform/vkms" },
    });
    expect(listGpuCards(virt)).toEqual([]);
  });
});

describe("utilisation", () => {
  const card = { card: "card1", pdev: "p", driver: "i915" };

  test("the fdinfo engine figure wins — it is what the process rows use too", () => {
    const engines = new Map([["render", 37]]);
    const fs = fakeLinuxFs({ files: { "/sys/class/drm/card1/device/gpu_busy_percent": "90" } });
    expect(utilisation(card, "/sys/class/drm/card1", engines, null, { atSec: 1 }, fs)).toBe(37);
  });

  test("amdgpu's own counter is next when fdinfo said nothing", () => {
    const fs = fakeLinuxFs({ files: { "/sys/class/drm/card0/device/gpu_busy_percent": "62" } });
    expect(utilisation({ ...card, driver: "amdgpu" }, "/sys/class/drm/card0", undefined, null, { atSec: 1 }, fs)).toBe(62);
  });

  test("rc6 is idle residency, so busy is its complement", () => {
    expect(rc6BusyPercent({ atSec: 0, rc6Ms: 1000 }, { atSec: 1, rc6Ms: 1800 })).toBe(20);
    expect(rc6BusyPercent({ atSec: 0, rc6Ms: 1000 }, { atSec: 1, rc6Ms: 2000 })).toBe(0);
  });

  test("no baseline and a counter reset both report nothing rather than a spike", () => {
    expect(rc6BusyPercent(null, { atSec: 1, rc6Ms: 5 })).toBeUndefined();
    expect(rc6BusyPercent({ atSec: 0, rc6Ms: 900 }, { atSec: 1, rc6Ms: 5 })).toBeUndefined();
  });
});

describe("amdgpu DPM tables", () => {
  const table = "0: 500Mhz\n1: 1200Mhz *\n2: 2100Mhz\n";
  test("the live state is the line marked with a star", () => {
    expect(pickDpmCurrent(table)).toBe(1200);
    expect(pickDpmMax(table)).toBe(2100);
  });
  test("no table at all reports nothing", () => {
    expect(pickDpmCurrent(undefined)).toBeUndefined();
    expect(pickDpmMax(undefined)).toBeUndefined();
  });
});

describe("pcieLink", () => {
  test("the rate identifies the generation", () => {
    expect(pcieGen("8.0 GT/s PCIe")).toBe(3);
    expect(pcieGen("16.0 GT/s PCIe")).toBe(4);
    expect(pcieGen("Unknown")).toBeUndefined();
  });

  test("an integrated GPU has no link at all — no zeros, no keys", () => {
    const fs = fakeLinuxFs({
      files: {
        "/sys/class/drm/card1/device/current_link_speed": "Unknown",
        "/sys/class/drm/card1/device/current_link_width": "0",
      },
    });
    expect(pcieLink("/sys/class/drm/card1", fs)).toEqual({});
  });

  test("the maximum is reported only when it differs from the live link", () => {
    const same = fakeLinuxFs({
      files: {
        "/sys/class/drm/card0/device/current_link_speed": "16.0 GT/s PCIe",
        "/sys/class/drm/card0/device/current_link_width": "16",
        "/sys/class/drm/card0/device/max_link_speed": "16.0 GT/s PCIe",
        "/sys/class/drm/card0/device/max_link_width": "16",
      },
    });
    expect(pcieLink("/sys/class/drm/card0", same)).toEqual({ pcieGen: 4, pcieLanes: 16 });

    const downgraded = fakeLinuxFs({
      files: {
        "/sys/class/drm/card0/device/current_link_speed": "2.5 GT/s PCIe",
        "/sys/class/drm/card0/device/current_link_width": "8",
        "/sys/class/drm/card0/device/max_link_speed": "16.0 GT/s PCIe",
        "/sys/class/drm/card0/device/max_link_width": "16",
      },
    });
    expect(pcieLink("/sys/class/drm/card0", downgraded))
      .toEqual({ pcieGen: 1, pcieLanes: 8, pcieMaxGen: 4, pcieMaxLanes: 16 });
  });
});

describe("readGpuInfo", () => {
  const fs = fakeLinuxFs({
    files: {
      "/run/udev/data/+pci:0000:00:02.0": "E:ID_MODEL_FROM_DATABASE=Alder Lake-S GT1 [UHD Graphics 770]",
      "/sys/class/drm/card1/device/current_link_speed": "Unknown",
    },
  });
  const card = { card: "card1", pdev: "0000:00:02.0", driver: "i915", vendor: "Intel" };

  test("the name is udev's PCI database entry, not the bare address", () => {
    expect(gpuName(card, fs)).toBe("Alder Lake-S GT1 [UHD Graphics 770]");
  });

  test("an unknown device falls back to vendor + driver, never an empty string", () => {
    expect(gpuName({ card: "card0", pdev: "0000:03:00.0", driver: "amdgpu", vendor: "AMD" }, fakeLinuxFs({}))).toBe("AMD amdgpu");
    expect(gpuName({ card: "card0", pdev: "0000:03:00.0", driver: "" }, fakeLinuxFs({}))).toBe("0000:03:00.0");
  });

  test("Intel's single video engine is flagged so the page says 'encode/decode'", () => {
    const info = readGpuInfo(card, { opengl: "4.6", vulkan: "1.4.354", mesa: "Mesa 26.2.2" }, fs);
    expect(info).toMatchObject({
      id: "0000:00:02.0", driver: "i915", vendor: "Intel",
      openglVersion: "4.6", vulkanVersion: "1.4.354", driverVersion: "Mesa 26.2.2",
      encodeDecodeShared: true,
    });
    expect("pcieGen" in info).toBe(false);
  });
});

describe("readUncoreEnergy", () => {
  test("the uncore sub-domain of a package is the iGPU's power source", () => {
    const fs = fakeLinuxFs({
      dirs: {
        "/sys/class/powercap": ["intel-rapl", "intel-rapl:0"],
        "/sys/class/powercap/intel-rapl:0": ["intel-rapl:0:0", "intel-rapl:0:1", "name"],
      },
      files: {
        "/sys/class/powercap/intel-rapl:0/intel-rapl:0:0/name": "core",
        "/sys/class/powercap/intel-rapl:0/intel-rapl:0:1/name": "uncore",
        "/sys/class/powercap/intel-rapl:0/intel-rapl:0:1/energy_uj": "555",
      },
    });
    expect(readUncoreEnergy(fs)).toBe(555);
    expect(readUncoreEnergy(fakeLinuxFs({}))).toBeUndefined();
  });
});

describe("collectLinuxGpus", () => {
  const fs = fakeLinuxFs({
    dirs: { "/sys/class/drm": ["card1"] },
    real: { "/sys/class/drm/card1/device": "/sys/devices/pci0000:00/0000:00:02.0" },
    links: { "/sys/class/drm/card1/device/driver": "../../../bus/pci/drivers/i915" },
    files: {
      "/sys/class/drm/card1/device/vendor": "0x8086",
      "/sys/class/drm/card1/power/rc6_residency_ms": "1000",
      "/sys/class/drm/card1/gt_cur_freq_mhz": "1433",
      "/sys/class/drm/card1/gt_act_freq_mhz": "0",
      "/sys/class/drm/card1/gt_RP0_freq_mhz": "1550",
      "/run/udev/data/+pci:0000:00:02.0": "E:ID_MODEL_FROM_DATABASE=UHD Graphics 770",
    },
  });
  const noUsage = { perDevice: new Map(), perProcess: new Map(), sharedByDevice: new Map() };

  test("the REQUESTED clock is reported — the actual one reads 0 whenever the GPU is parked", () => {
    const { gpus } = collectLinuxGpus(new Map(), noUsage, fs, () => 0);
    expect(gpus[0]?.clockMHz).toBe(1433);
  });

  test("an integrated GPU reports a 0 VRAM total, which means 'has none'", () => {
    const { gpus } = collectLinuxGpus(new Map(), noUsage, fs, () => 0);
    expect(gpus[0]).toMatchObject({ id: "0000:00:02.0", name: "UHD Graphics 770", vramTotalMB: 0, clockMHz: 1433, clockMaxMHz: 1550 });
  });

  test("NVIDIA is left to its own collector rather than listed twice", () => {
    const nv = fakeLinuxFs({
      dirs: { "/sys/class/drm": ["card0"] },
      real: { "/sys/class/drm/card0/device": "/sys/devices/pci0000:00/0000:01:00.0" },
      links: { "/sys/class/drm/card0/device/driver": "../../../bus/pci/drivers/nvidia" },
      files: { "/sys/class/drm/card0/device/vendor": "0x10de" },
    });
    expect(collectLinuxGpus(new Map(), noUsage, nv, () => 0).gpus).toEqual([]);
  });

  test("the second tick measures rc6 against the first", () => {
    const first = collectLinuxGpus(new Map(), noUsage, fs, () => 0);
    const second = collectLinuxGpus(first.next, noUsage, fs, () => 2000);
    // The fixture's rc6 never moves, so the GPU was busy the whole interval.
    expect(second.gpus[0]?.utilPercent).toBe(100);
  });

  test("an iGPU's memory usage comes from its clients, against the machine's RAM", () => {
    const usage = { perDevice: new Map(), perProcess: new Map(), sharedByDevice: new Map([["0000:00:02.0", 2580]]) };
    const { gpus } = collectLinuxGpus(new Map(), usage, fs, () => 0, 64 * 1024 ** 3);
    // What Mission Center reads as "Memory Usage 2.52 GiB / 62.5 GiB".
    expect(gpus[0]).toMatchObject({ sharedUsedMB: 2580, sharedTotalMB: 65536 });
  });
});

describe("sharedMemory", () => {
  const card = { card: "card1", pdev: "0000:00:02.0", driver: "i915" };
  const empty = { perDevice: new Map(), perProcess: new Map(), sharedByDevice: new Map() };
  const withClients = { ...empty, sharedByDevice: new Map([["0000:00:02.0", 1536.4]]) };

  test("amdgpu's own GTT counters win — the aperture is that card's real ceiling", () => {
    const fs = fakeLinuxFs({
      files: {
        "/sys/class/drm/card1/device/mem_info_gtt_used": String(512 * 1024 ** 2),
        "/sys/class/drm/card1/device/mem_info_gtt_total": String(8 * 1024 ** 3),
      },
    });
    expect(sharedMemory(card, "/sys/class/drm/card1", withClients, fs, 64 * 1024 ** 3))
      .toEqual({ sharedUsedMB: 512, sharedTotalMB: 8192 });
  });

  test("with no sysfs counters the clients are summed against system RAM", () => {
    expect(sharedMemory(card, "/sys/class/drm/card1", withClients, fakeLinuxFs({}), 64 * 1024 ** 3))
      .toEqual({ sharedUsedMB: 1536, sharedTotalMB: 65536 });
  });

  test("no client on this device reports nothing — an em dash, never 0 / 62.5 GiB", () => {
    expect(sharedMemory(card, "/sys/class/drm/card1", empty, fakeLinuxFs({}), 64 * 1024 ** 3)).toEqual({});
  });

  test("a used figure with no ceiling is not a reading, so neither half is sent", () => {
    const halfSysfs = fakeLinuxFs({
      files: { "/sys/class/drm/card1/device/mem_info_gtt_used": String(512 * 1024 ** 2) },
    });
    expect(sharedMemory(card, "/sys/class/drm/card1", empty, halfSysfs, 0)).toEqual({});
    // ...and with clients to fall back on, the RAM total is what completes it.
    expect(sharedMemory(card, "/sys/class/drm/card1", withClients, halfSysfs, 0)).toEqual({});
  });
});

describe("GPU API versions", () => {
  const EGLINFO = [
    "EGL version string: 1.5",
    "OpenGL core profile version string: 4.6 (Core Profile) Mesa 26.2.2-arch3.2",
    "OpenGL ES profile version string: OpenGL ES 3.2 Mesa 26.2.2-arch3.2",
  ].join("\n");

  test("the core profile is preferred over compatibility and ES", () => {
    expect(parseOpenglVersion(EGLINFO)).toBe("4.6");
  });

  test("a driver with only ES reports ES, which is what Mission Center shows", () => {
    expect(parseOpenglVersion("OpenGL ES profile version string: OpenGL ES 3.2 Mesa 22")).toBe("ES 3.2");
    expect(parseOpenglVersion("nothing here")).toBeUndefined();
  });

  test("the highest device apiVersion is the machine's Vulkan level", () => {
    expect(parseVulkanVersion("apiVersion = 1.2.0\n\tapiVersion         = 1.4.354\n")).toBe("1.4.354");
    expect(parseVulkanVersion("")).toBeUndefined();
  });

  test("Mesa's version is the meaningful driver version for the open drivers", () => {
    expect(parseMesaVersion(EGLINFO)).toBe("Mesa 26.2.2-arch3.2");
    expect(parseMesaVersion("no mention")).toBeUndefined();
  });

  test("the vendor string 'Mesa Project' is not a version — anchor to the GL line", () => {
    const withVendor = ["EGL vendor string: Mesa Project", "EGL version string: 1.5", EGLINFO].join("\n");
    expect(parseMesaVersion(withVendor)).toBe("Mesa 26.2.2-arch3.2");
    // A report with the vendor line and NO OpenGL line has no version to give.
    expect(parseMesaVersion("EGL vendor string: Mesa Project")).toBeUndefined();
  });

  test("the tools are spawned once for the process, however many callers ask", async () => {
    let runs = 0;
    const reader = createGpuApiVersionReader(async (argv) => {
      runs++;
      // eglinfo is reached through `env`, which is what carries EGL_PLATFORM.
      const isEgl = argv.includes("eglinfo");
      if (isEgl) expect(argv).toContain("EGL_PLATFORM=surfaceless");
      return { stdout: isEgl ? EGLINFO : "apiVersion = 1.4.354", stderr: "", code: 0, timedOut: false };
    });
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect(a).toEqual({ opengl: "4.6", mesa: "Mesa 26.2.2-arch3.2", vulkan: "1.4.354" });
    expect(b).toBe(a);
    await reader.read();
    expect(runs).toBe(2);
  });

  test("a host with neither tool reports nothing rather than failing", async () => {
    const reader = createGpuApiVersionReader(async () => { throw new Error("ENOENT"); });
    expect(await reader.read()).toEqual({});
  });
});

describe("GPU API versions — exit codes", () => {
  const EGLINFO_REAL = "EGL version string: 1.5\nOpenGL core profile version: 4.6 (Core Profile) Mesa 26.2.2-arch3.2\n";

  test("eglinfo exits 1 on a headless host while printing a correct report — parse it anyway", async () => {
    const reader = createGpuApiVersionReader(async (argv) => ({
      stdout: argv.includes("eglinfo") ? EGLINFO_REAL : "",
      stderr: "", code: 1, timedOut: false,
    }));
    expect(await reader.read()).toEqual({ opengl: "4.6", mesa: "Mesa 26.2.2-arch3.2" });
  });

  test("a timeout or empty output is still nothing, whatever the code says", async () => {
    const timedOut = createGpuApiVersionReader(async () => ({ stdout: EGLINFO_REAL, stderr: "", code: 0, timedOut: true }));
    expect(await timedOut.read()).toEqual({});
    const empty = createGpuApiVersionReader(async () => ({ stdout: "   ", stderr: "", code: 0, timedOut: false }));
    expect(await empty.read()).toEqual({});
  });
});
