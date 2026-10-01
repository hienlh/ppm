/**
 * Per-drive figures on macOS, parsed from a real `ioreg` capture (M1 Max) that
 * holds exactly the three cases that matter: the internal SSD, a built-in SD
 * reader with no card in it, and a mounted disk image.
 */
import { describe, expect, test } from "bun:test";
import {
  collectDarwinDiskDevices, EMBEDDED_NVME_CLASS, parseBlockDevices, sumDiskCounters, toDiskSample,
  type DarwinBlockDevice, type DarwinDiskStats,
} from "../../../../src/services/system-metrics/disk-devices-darwin.ts";
import { toDiskMetrics } from "../../../../src/services/system-metrics/disk-devices-linux.ts";
import { parsePlistXml, type PlistDict } from "../../../../src/services/system-metrics/plist-xml.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const IOREG = parsePlistXml(darwinFixture("ioreg-block-devices.xml"));
const MB = 1024 * 1024;

const stats = (over: Partial<DarwinDiskStats> = {}): DarwinDiskStats => ({
  readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0, readTimeNs: 0, writeTimeNs: 0, ...over,
});

/** A registry entry shaped like ioreg's: device → driver → whole media. */
function device(bsd: string, over: { interconnect?: string; location?: string; removable?: boolean } = {}): PlistDict {
  return {
    "Device Characteristics": { "Product Name": "Flash Disk  ", "Vendor Name": "Generic " },
    "Protocol Characteristics": {
      "Physical Interconnect": over.interconnect ?? "USB",
      "Physical Interconnect Location": over.location ?? "External",
    },
    IOObjectClass: "IOSCSIPeripheralDeviceType00",
    IORegistryEntryChildren: [{
      IOObjectClass: "IOBlockStorageDriver",
      Statistics: { "Bytes (Read)": 4096, "Bytes (Write)": 0, "Operations (Read)": 1 },
      IORegistryEntryChildren: [{
        "BSD Name": bsd, Whole: true, Size: 32 * 1024 * MB, Removable: over.removable ?? true, Ejectable: true,
      }],
    }],
  };
}

describe("parseBlockDevices", () => {
  test("lists the internal SSD with what it says about itself", () => {
    const [disk, ...rest] = parseBlockDevices(IOREG);
    expect(rest).toEqual([]);
    expect(disk).toEqual({
      id: "disk0",
      product: "APPLE SSD AP1024R",
      serial: "0000000000000000",
      medium: "Solid State",
      interconnect: "Apple Fabric",
      location: "Internal",
      ioClass: "IOEmbeddedNVMeBlockDevice",
      capacityBytes: 1000555581440,
      removable: false,
      ejectable: false,
      stats: {
        readBytes: 669290475520, writeBytes: 236940701696,
        readOps: 58638888, writeOps: 19930034,
        readTimeNs: 13318483212534, writeTimeNs: 1126681813915,
      },
    });
  });

  test("an empty vendor field is absent rather than an empty string", () => {
    expect("vendor" in parseBlockDevices(IOREG)[0]!).toBe(false);
  });

  test("skips the mounted disk image, whose bytes are the SSD's bytes again", () => {
    // disk4 is in the capture with media and counters of its own.
    expect(darwinFixture("ioreg-block-devices.xml")).toContain("<string>disk4</string>");
    expect(parseBlockDevices(IOREG).map((d) => d.id)).not.toContain("disk4");
  });

  test("skips a card reader with no card in it", () => {
    expect(darwinFixture("ioreg-block-devices.xml")).toContain("Built In SDXC Reader");
    expect(parseBlockDevices(IOREG).some((d) => d.product?.includes("SDXC"))).toBe(false);
  });

  test("lists a USB stick, trims its padded fields, and sorts by unit number", () => {
    const disks = parseBlockDevices([device("disk10"), device("disk2"), ...(IOREG as PlistDict[])]);
    expect(disks.map((d) => d.id)).toEqual(["disk0", "disk2", "disk10"]);
    const stick = disks[1]!;
    expect(stick.product).toBe("Flash Disk");
    expect(stick.vendor).toBe("Generic");
    expect(stick.interconnect).toBe("USB");
    expect(stick.removable).toBe(true);
    expect(stick.ejectable).toBe(true);
    // A counter the driver did not publish reads as zero, not as a broken drive.
    expect(stick.stats).toEqual(stats({ readBytes: 4096, readOps: 1 }));
  });

  test("a disk image is recognised by either field, not only by both", () => {
    const byInterconnect = device("disk5", { interconnect: "Virtual Interface", location: "Internal" });
    const byLocation = device("disk6", { interconnect: "USB", location: "File" });
    expect(parseBlockDevices([byInterconnect, byLocation])).toEqual([]);
  });

  test("anything that is not the registry tree yields no drives rather than throwing", () => {
    expect(parseBlockDevices(undefined)).toEqual([]);
    expect(parseBlockDevices("disk0")).toEqual([]);
    expect(parseBlockDevices([1, "x", { IORegistryEntryChildren: "nope" }])).toEqual([]);
  });
});

describe("rates from IOKit counters", () => {
  const before = stats({ readBytes: 1000 * MB, writeBytes: 500 * MB, readOps: 10_000, writeOps: 5_000 });
  const after = stats({
    readBytes: 1100 * MB, writeBytes: 550 * MB, readOps: 11_000, writeOps: 5_500,
    readTimeNs: 500e6, writeTimeNs: 250e6,
  });

  test("throughput, response time and the busy estimate, over two samples 2 s apart", () => {
    const m = toDiskMetrics("disk0", toDiskSample(before, 100), toDiskSample(after, 102), undefined);
    expect(m.available).toBe(true);
    expect(m.readBps).toBe(50 * MB);
    expect(m.writeBps).toBe(25 * MB);
    // 750 ms of request time over 1500 requests.
    expect(m.responseMs).toBe(0.5);
    // …and over 2 s of wall time.
    expect(m.busyPercent).toBe(37.5);
  });

  test("overlapping requests cap the estimate at 100% instead of passing it", () => {
    const flooded = stats({ ...after, readTimeNs: 16_000e6 });
    expect(toDiskMetrics("disk0", toDiskSample(before, 100), toDiskSample(flooded, 102), undefined).busyPercent)
      .toBe(100);
  });

  test("totals are the exact byte counts, not rounded to sectors", () => {
    const odd = stats({ readBytes: 669290475520 + 100, writeBytes: 7 });
    const m = toDiskMetrics("disk0", null, toDiskSample(odd, 1), undefined);
    expect(m.readTotal).toBe(669290475620);
    expect(m.writeTotal).toBe(7);
  });

  test("the first sample reports no rates but real totals", () => {
    const m = toDiskMetrics("disk0", null, toDiskSample(after, 1), undefined);
    expect(m).toMatchObject({ available: false, readBps: 0, busyPercent: 0, readTotal: 1100 * MB });
  });
});

describe("collectDarwinDiskDevices", () => {
  const disk = (id: string, s: DarwinDiskStats): DarwinBlockDevice => ({
    id, capacityBytes: 1, removable: false, ejectable: false, stats: s,
  });

  test("measures each drive against its own baseline", () => {
    const first = collectDarwinDiskDevices([disk("disk0", stats({ readBytes: 0 }))], 10, new Map());
    // A stick plugged in between the two ticks.
    const second = collectDarwinDiskDevices(
      [disk("disk0", stats({ readBytes: 2 * MB })), disk("disk4", stats({ readBytes: 900 * MB }))],
      12,
      first.next,
    );
    expect(second.disks.map((d) => [d.id, d.available, d.readBps])).toEqual([
      ["disk0", true, MB],
      // Measured from zero it would claim 450 MB/s it never moved.
      ["disk4", false, 0],
    ]);
    expect([...second.next.keys()]).toEqual(["disk0", "disk4"]);
  });

  test("a drive that goes away leaves no baseline behind", () => {
    const first = collectDarwinDiskDevices([disk("disk4", stats())], 10, new Map());
    expect(collectDarwinDiskDevices([], 12, first.next).next.size).toBe(0);
  });

  const embedded = (id: string): DarwinBlockDevice => ({ ...disk(id, stats()), ioClass: EMBEDDED_NVME_CLASS });

  test("the internal flash's temperature goes to the built-in SSD, not to a drive beside it", () => {
    const out = collectDarwinDiskDevices([embedded("disk0"), disk("disk4", stats())], 10, new Map(), 34);
    expect(out.disks.map((d) => [d.id, d.tempC])).toEqual([["disk0", 34], ["disk4", undefined]]);
  });

  test("with no built-in SSD, or more than one, no drive is given it", () => {
    const none = collectDarwinDiskDevices([disk("disk0", stats()), disk("disk4", stats())], 10, new Map(), 34);
    expect(none.disks.some((d) => d.tempC !== undefined)).toBe(false);
    const two = collectDarwinDiskDevices([embedded("disk0"), embedded("disk1")], 10, new Map(), 34);
    expect(two.disks.some((d) => d.tempC !== undefined)).toBe(false);
  });

  test("a sensor that did not answer is no figure", () => {
    const out = collectDarwinDiskDevices([embedded("disk0")], 10, new Map(), undefined);
    expect(out.disks[0]).not.toHaveProperty("tempC");
  });
});

describe("sumDiskCounters", () => {
  test("is the drives the pages list, so the disk image is not in it", () => {
    expect(sumDiskCounters(parseBlockDevices(IOREG))).toEqual({ inBytes: 669290475520, outBytes: 236940701696 });
  });

  test("is null — unavailable, not zero — when there is no drive to sum", () => {
    expect(sumDiskCounters([])).toBeNull();
  });
});
