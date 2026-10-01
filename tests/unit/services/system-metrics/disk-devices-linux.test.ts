import { describe, test, expect } from "bun:test";
import {
  collectLinuxDiskDevices,
  isIgnoredDisk,
  listDiskDevices,
  parseDiskStat,
  readDiskTempC,
  toDiskMetrics,
  type DiskSample,
} from "../../../../src/services/system-metrics/disk-devices-linux.ts";
import { fakeLinuxFs } from "./fixtures/fake-linux-fs.ts";

/** A real line off this repo's dev host (17 fields, kernel 6.x). */
const NVME_STAT = "  126007    21884 16789853   125174   509353    15348 15335728   255537        0   104954   391893     3734        0 12756632      608     3107    10573\n";

const sample = (over: Partial<DiskSample> = {}): DiskSample => ({
  atSec: 0,
  readIos: 0, readSectors: 0, readTicks: 0,
  writeIos: 0, writeSectors: 0, writeTicks: 0,
  ioTicks: 0, discardIos: 0, discardTicks: 0, flushIos: 0, flushTicks: 0,
  ...over,
});

describe("parseDiskStat", () => {
  test("reads the fields Mission Center reads, by index", () => {
    const s = parseDiskStat(NVME_STAT, 10);
    expect(s).toEqual(sample({
      atSec: 10,
      readIos: 126007, readSectors: 16789853, readTicks: 125174,
      writeIos: 509353, writeSectors: 15335728, writeTicks: 255537,
      ioTicks: 104954, discardIos: 3734, discardTicks: 608, flushIos: 3107, flushTicks: 10573,
    }));
  });

  test("a pre-5.5 line without the discard/flush groups still parses", () => {
    const s = parseDiskStat("1 2 3 4 5 6 7 8 0 9 10", 0);
    expect(s?.ioTicks).toBe(9);
    expect(s?.discardIos).toBe(0);
    expect(s?.flushTicks).toBe(0);
  });

  test("a truncated or non-numeric line is no sample at all", () => {
    expect(parseDiskStat("1 2 3", 0)).toBeNull();
    expect(parseDiskStat("1 2 3 4 5 6 7 x 0 9 10", 0)).toBeNull();
  });
});

describe("listDiskDevices", () => {
  test("drops the virtual prefixes and zero-size devices, sorted", () => {
    const fs = fakeLinuxFs({
      dirs: { "/sys/block": ["sda", "zram0", "loop3", "nvme0n1", "dm-0", "sr0", "md127"] },
      files: {
        "/sys/block/sda/size": "468862128",
        "/sys/block/nvme0n1/size": "500118192",
        "/sys/block/sr0/size": "0",
        "/sys/block/zram0/size": "130990080",
      },
    });
    expect(listDiskDevices(fs)).toEqual(["nvme0n1", "sda"]);
  });

  test("an unreadable /sys/block is an empty list, not a throw", () => {
    expect(listDiskDevices(fakeLinuxFs({}))).toEqual([]);
  });

  test("the ignore list matches Mission Center's prefixes", () => {
    for (const id of ["loop0", "ram1", "zram0", "fd0", "md127", "dm-0", "zd16"]) {
      expect(isIgnoredDisk(id)).toBe(true);
    }
    for (const id of ["sda", "nvme0n1", "vda", "mmcblk0", "sr0"]) {
      expect(isIgnoredDisk(id)).toBe(false);
    }
  });
});

describe("toDiskMetrics", () => {
  test("first sample: unavailable, but the totals are real absolutes", () => {
    const m = toDiskMetrics("sda", null, sample({ readSectors: 100, writeSectors: 50 }), undefined);
    expect(m.available).toBe(false);
    expect(m.busyPercent).toBe(0);
    expect(m.readTotal).toBe(100 * 512);
    expect(m.writeTotal).toBe(50 * 512);
  });

  test("busy% is iostat %util: io_ticks over the interval", () => {
    const prev = sample({ atSec: 0, ioTicks: 1000 });
    const next = sample({ atSec: 2, ioTicks: 1500 });
    // 500 ms busy over 2 s = 25 %.
    expect(toDiskMetrics("sda", prev, next, undefined).busyPercent).toBe(25);
  });

  test("busy% is capped at 100 for a multi-queue device", () => {
    const m = toDiskMetrics("nvme0n1", sample({ atSec: 0 }), sample({ atSec: 1, ioTicks: 8000 }), undefined);
    expect(m.busyPercent).toBe(100);
  });

  test("response time is weighted ticks over completed requests, all four kinds", () => {
    const prev = sample({ atSec: 0 });
    const next = sample({
      atSec: 1,
      readTicks: 40, writeTicks: 50, discardTicks: 6, flushTicks: 4,
      readIos: 10, writeIos: 5, discardIos: 4, flushIos: 1,
    });
    // (40+50+6+4) / (10+5+4+1) = 100/20 = 5 ms.
    expect(toDiskMetrics("sda", prev, next, undefined).responseMs).toBe(5);
  });

  test("no completed requests → 0 ms rather than a division by zero", () => {
    const m = toDiskMetrics("sda", sample({ atSec: 0 }), sample({ atSec: 1, readTicks: 7 }), undefined);
    expect(m.responseMs).toBe(0);
  });

  test("throughput is sectors x 512 over the interval", () => {
    const prev = sample({ atSec: 0, readSectors: 0, writeSectors: 0 });
    const next = sample({ atSec: 2, readSectors: 4000, writeSectors: 2000 });
    const m = toDiskMetrics("sda", prev, next, undefined);
    expect(m.readBps).toBe(4000 * 512 / 2);
    expect(m.writeBps).toBe(2000 * 512 / 2);
  });

  test("counters walking backwards (a re-plug) is one unavailable tick, never a negative rate", () => {
    const prev = sample({ atSec: 0, ioTicks: 5000, readSectors: 900 });
    const next = sample({ atSec: 1, ioTicks: 10, readSectors: 5 });
    const m = toDiskMetrics("sda", prev, next, undefined);
    expect(m.available).toBe(false);
    expect(m.readBps).toBe(0);
  });

  test("a zero or reversed interval is unavailable", () => {
    expect(toDiskMetrics("sda", sample({ atSec: 5 }), sample({ atSec: 5 }), undefined).available).toBe(false);
    expect(toDiskMetrics("sda", sample({ atSec: 5 }), sample({ atSec: 4 }), undefined).available).toBe(false);
  });

  test("no sensor → no tempC key at all, so the UI shows nothing rather than 0 C", () => {
    expect("tempC" in toDiskMetrics("sda", null, sample(), undefined)).toBe(false);
    expect(toDiskMetrics("nvme0n1", null, sample(), 51.9).tempC).toBe(51.9);
  });
});

describe("readDiskTempC", () => {
  test("millidegrees off the drive's own hwmon, one decimal", () => {
    const fs = fakeLinuxFs({
      dirs: { "/sys/block/nvme0n1/device": ["hwmon1", "nvme0"] },
      files: { "/sys/block/nvme0n1/device/hwmon1/temp1_input": "51850\n" },
    });
    expect(readDiskTempC("nvme0n1", fs)).toBe(51.9);
  });

  test("a SATA drive without drivetemp has no hwmon → undefined", () => {
    const fs = fakeLinuxFs({ dirs: { "/sys/block/sda/device": ["block", "scsi_disk"] } });
    expect(readDiskTempC("sda", fs)).toBeUndefined();
  });
});

describe("collectLinuxDiskDevices", () => {
  const fs = fakeLinuxFs({
    dirs: { "/sys/block": ["nvme0n1", "zram0"], "/sys/block/nvme0n1/device": ["hwmon1"] },
    files: {
      "/sys/block/nvme0n1/size": "500118192",
      "/sys/block/nvme0n1/stat": NVME_STAT,
      "/sys/block/nvme0n1/device/hwmon1/temp1_input": "51850",
      "/sys/block/zram0/size": "130990080",
      "/sys/block/zram0/stat": NVME_STAT,
    },
  });

  test("first tick measures nothing and seeds the baseline", () => {
    const { disks, next } = collectLinuxDiskDevices(new Map(), fs, () => 1000);
    expect(disks.map((d) => d.id)).toEqual(["nvme0n1"]);
    expect(disks[0]?.available).toBe(false);
    expect(disks[0]?.tempC).toBe(51.9);
    expect(next.get("nvme0n1")?.atSec).toBe(1);
  });

  test("second tick measures against this device's own previous sample", () => {
    const first = collectLinuxDiskDevices(new Map(), fs, () => 1000);
    const second = collectLinuxDiskDevices(first.next, fs, () => 3000);
    expect(second.disks[0]?.available).toBe(true);
    // Same fixture twice: no movement, so every rate is a true zero.
    expect(second.disks[0]?.readBps).toBe(0);
    expect(second.disks[0]?.busyPercent).toBe(0);
  });

  test("a device that appears mid-session is unavailable for exactly one tick", () => {
    const prev = new Map([["sdb", { ...sample({ atSec: 0 }) }]]);
    const { disks } = collectLinuxDiskDevices(prev, fs, () => 2000);
    expect(disks[0]?.available).toBe(false);
  });
});
