import { describe, test, expect } from "bun:test";
import { enrichMemory, parseMeminfo, readMemoryInfo } from "../../../../src/services/system-metrics/memory-linux.ts";
import { collectLinuxFans, fanIndices } from "../../../../src/services/system-metrics/fans-linux.ts";
import { fakeLinuxFs } from "./fixtures/fake-linux-fs.ts";

const KB = 1024;
const base = { totalMB: 100, usedMB: 40, availableMB: 60, percent: 40 };

const meminfo = (over: Record<string, number> = {}) => Object.entries({
  MemTotal: 1000, MemFree: 200, MemAvailable: 600, Buffers: 10, Cached: 350,
  Dirty: 20, Writeback: 5, SReclaimable: 40, SwapTotal: 500, SwapFree: 400,
  Committed_AS: 900, CommitLimit: 1500, ...over,
}).map(([k, v]) => `${k}:${String(v).padStart(12)} kB`).join("\n");

describe("parseMeminfo", () => {
  test("kB lines become bytes; unitless lines stay verbatim", () => {
    const m = parseMeminfo("MemTotal:       1000 kB\nHugePages_Total:       0\nBroken\n");
    expect(m.get("MemTotal")).toBe(1000 * KB);
    expect(m.get("HugePages_Total")).toBe(0);
    expect(m.has("Broken")).toBe(false);
  });
});

describe("enrichMemory", () => {
  test("the four parts add up to the total exactly, so the bar cannot overflow", () => {
    const m = enrichMemory(base, meminfo());
    const sum = m.inUseBytes! + m.modifiedBytes! + m.standbyBytes! + m.freeBytes!;
    expect(sum).toBe(1000 * KB);
  });

  test("'in use' in the bar IS the headline figure — total minus available", () => {
    const m = enrichMemory(base, meminfo());
    expect(m.inUseBytes).toBe((1000 - 600) * KB);
  });

  test("modified is carved out of standby, never added to it", () => {
    const m = enrichMemory(base, meminfo());
    // Reclaimable = available - free = 400 kB; Dirty+Writeback = 25 kB of that.
    expect(m.modifiedBytes).toBe(25 * KB);
    expect(m.standbyBytes).toBe((400 - 25) * KB);
  });

  test("a kernel reporting more dirty than reclaimable still adds up", () => {
    const m = enrichMemory(base, meminfo({ Dirty: 900, Writeback: 900 }));
    const sum = m.inUseBytes! + m.modifiedBytes! + m.standbyBytes! + m.freeBytes!;
    expect(sum).toBe(1000 * KB);
    expect(m.standbyBytes).toBe(0);
  });

  test("an old kernel with no MemAvailable falls back to free, and still adds up", () => {
    const text = "MemTotal:       1000 kB\nMemFree:        200 kB\nDirty:            0 kB\n";
    const m = enrichMemory(base, text);
    expect(m.freeBytes).toBe(200 * KB);
    expect(m.standbyBytes).toBe(0);
    expect(m.inUseBytes! + m.freeBytes!).toBe(1000 * KB);
  });

  test("swap used is total minus free, and never negative", () => {
    expect(enrichMemory(base, meminfo()).swapUsedMB).toBe(round1(100 * KB / 1048576));
    expect(enrichMemory(base, meminfo({ SwapFree: 900 })).swapUsedMB).toBe(0);
  });

  test("no meminfo (not Linux) leaves the base untouched — no zeroed fields", () => {
    expect(enrichMemory(base, null)).toEqual(base);
    expect(enrichMemory(base, "garbage")).toEqual(base);
  });
});

describe("readMemoryInfo", () => {
  const dmi = [
    "E:MEMORY_ARRAY_MAX_CAPACITY=137438953472",
    "E:MEMORY_DEVICE_0_SIZE=17179869184",
    "E:MEMORY_DEVICE_0_LOCATOR=DDR4-A1",
    "E:MEMORY_DEVICE_0_BANK_LOCATOR=BANK 0",
    "E:MEMORY_DEVICE_0_FORM_FACTOR=DIMM",
    "E:MEMORY_DEVICE_0_TYPE=DDR4",
    "E:MEMORY_DEVICE_0_SPEED_MTS=2133",
    "E:MEMORY_DEVICE_0_MANUFACTURER=G Skill Intl",
    "E:MEMORY_DEVICE_0_RANK=2",
    "E:MEMORY_DEVICE_1_LOCATOR=DDR4-A2",
    "E:MEMORY_DEVICE_1_SIZE=0",
    "E:MEMORY_DEVICE_2_SIZE=17179869184",
    "E:MEMORY_DEVICE_2_LOCATOR=DDR4-B1",
  ].join("\n");
  const fs = fakeLinuxFs({ files: { "/run/udev/data/+dmi:id": dmi } });

  test("the firmware table udev already decoded, no root and no dmidecode", () => {
    const info = readMemoryInfo(fs);
    expect(info.devices).toHaveLength(2);
    expect(info.devices[0]).toEqual({
      locator: "DDR4-A1", sizeBytes: 17179869184, bankLocator: "BANK 0",
      formFactor: "DIMM", ramType: "DDR4", speedMts: 2133, manufacturer: "G Skill Intl", rank: 2,
    });
    expect(info.maxCapacityBytes).toBe(137438953472);
  });

  test("an empty slot (size 0) is skipped without ending the walk", () => {
    expect(readMemoryInfo(fs).devices.map((d) => d.locator)).toEqual(["DDR4-A1", "DDR4-B1"]);
  });

  test("a VM with no SMBIOS record lists no slots rather than failing", () => {
    expect(readMemoryInfo(fakeLinuxFs({}))).toEqual({ devices: [] });
  });
});

describe("collectLinuxFans", () => {
  const fs = fakeLinuxFs({
    dirs: {
      "/sys/class/hwmon": ["hwmon0", "hwmon2"],
      "/sys/class/hwmon/hwmon0": ["name", "temp1_input"],
      "/sys/class/hwmon/hwmon2": ["name", "fan1_input", "fan2_input", "pwm1", "temp1_input", "temp2_input"],
    },
    files: {
      "/sys/class/hwmon/hwmon0/name": "acpitz",
      "/sys/class/hwmon/hwmon0/temp1_input": "16800",
      "/sys/class/hwmon/hwmon2/name": "it8689",
      "/sys/class/hwmon/hwmon2/fan1_input": "703",
      "/sys/class/hwmon/hwmon2/fan2_input": "0",
      "/sys/class/hwmon/hwmon2/pwm1": "51",
      "/sys/class/hwmon/hwmon2/temp1_input": "37000",
      "/sys/class/hwmon/hwmon2/temp2_input": "43000",
    },
  });

  test("only chips with a tachometer contribute, keyed by chip name", () => {
    const fans = collectLinuxFans(fs);
    expect(fans.map((f) => f.id)).toEqual(["it8689/fan1", "it8689/fan2"]);
  });

  test("a fan reading 0 is kept — an empty header is information", () => {
    expect(collectLinuxFans(fs)[1]).toMatchObject({ rpm: 0, tempC: 43 });
  });

  test("pwm is reported as a percentage of 255, not the raw byte", () => {
    expect(collectLinuxFans(fs)[0]?.pwmPercent).toBe(20);
    expect("pwmPercent" in collectLinuxFans(fs)[1]!).toBe(false);
  });

  test("the temperature with the same index rides along, as the board labels it", () => {
    expect(collectLinuxFans(fs)[0]).toMatchObject({ label: "Fan 1", tempC: 37 });
  });

  test("a host with no tachometer at all reports an empty list", () => {
    expect(collectLinuxFans(fakeLinuxFs({ dirs: { "/sys/class/hwmon": ["hwmon0"] } }))).toEqual([]);
  });

  test("fan indices are found by name and sorted numerically", () => {
    const many = fakeLinuxFs({ dirs: { d: ["fan10_input", "fan2_input", "fan1_input", "pwm1", "name"] } });
    expect(fanIndices(many, "d")).toEqual([1, 2, 10]);
  });
});

function round1(n: number) { return Math.round(n * 10) / 10; }
