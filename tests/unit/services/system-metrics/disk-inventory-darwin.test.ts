/**
 * The drive inventory on macOS, from the real captures of one M1 Max: the
 * `ioreg` drive tree, `diskutil list -plist` (three APFS containers on the SSD
 * plus a mounted disk image) and `mount`.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDarwinDiskInventory, darwinDiskKind, darwinDiskModel, parseDiskutilList, parseMountTable,
  readDarwinDiskInventory, readDarwinPartitions, wholeDiskOf,
} from "../../../../src/services/system-metrics/disk-inventory-darwin.ts";
import { parseBlockDevices, type DarwinBlockDevice } from "../../../../src/services/system-metrics/disk-devices-darwin.ts";
import type { DarwinToolReads } from "../../../../src/services/system-metrics/darwin-tool-reads.ts";
import { parsePlistXml } from "../../../../src/services/system-metrics/plist-xml.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const DEVICES = parseBlockDevices(parsePlistXml(darwinFixture("ioreg-block-devices.xml")));
const LAYOUT = parseDiskutilList(parsePlistXml(darwinFixture("diskutil-list.plist")));
const MOUNTS = parseMountTable(darwinFixture("mount.txt"));

describe("parseMountTable", () => {
  test("keeps the /dev mounts with their filesystem, and nothing else", () => {
    expect(MOUNTS.map((m) => m.id)).toEqual([
      "disk3s3s1", "disk3s6", "disk3s4", "disk3s2", "disk1s2", "disk1s1", "disk1s3", "disk3s1", "disk5s1",
    ]);
    expect(MOUNTS[0]).toEqual({ id: "disk3s3s1", mountPoint: "/", filesystem: "apfs" });
  });

  test("a mount point with spaces and parentheses of its own survives whole", () => {
    const [m] = parseMountTable("/dev/disk6s1 on /Volumes/My Drive (1) (exfat, local, nodev, nosuid, noowners)\n");
    expect(m).toEqual({ id: "disk6s1", mountPoint: "/Volumes/My Drive (1)", filesystem: "exfat" });
  });

  test("a filesystem with no options is still read", () => {
    expect(parseMountTable("/dev/disk7 on /Volumes/X (msdos)")).toEqual([
      { id: "disk7", mountPoint: "/Volumes/X", filesystem: "msdos" },
    ]);
  });
});

describe("parseDiskutilList", () => {
  test("maps the SSD's partitions, each container's store, and each volume's container", () => {
    expect(LAYOUT.partitions.get("disk0")?.map((p) => [p.id, p.content])).toEqual([
      ["disk0s1", "Apple_APFS_ISC"], ["disk0s2", "Apple_APFS"], ["disk0s3", "Apple_APFS_Recovery"],
    ]);
    expect(LAYOUT.containerStores.get("disk3")).toEqual(["disk0s2"]);
    expect(LAYOUT.volumeContainer.get("disk3s1")).toBe("disk3");
    // `/` is a sealed snapshot, listed under the volume it snapshots.
    expect(LAYOUT.volumeContainer.get("disk3s3s1")).toBe("disk3");
  });

  test("anything that is not the list yields an empty layout rather than throwing", () => {
    for (const bad of [undefined, "x", { AllDisksAndPartitions: "nope" }, { AllDisksAndPartitions: [1, {}] }]) {
      expect(parseDiskutilList(bad).partitions.size).toBe(0);
    }
  });
});

describe("wholeDiskOf", () => {
  test("follows / from its snapshot through the container to the SSD", () => {
    expect(wholeDiskOf("disk3s3s1", LAYOUT)).toBe("disk0");
    expect(wholeDiskOf("disk0s2", LAYOUT)).toBe("disk0");
  });

  test("puts the disk image's volume on the disk image, not on the SSD", () => {
    expect(wholeDiskOf("disk5s1", LAYOUT)).toBe("disk4");
  });

  test("an id the layout has never heard of belongs to no disk", () => {
    expect(wholeDiskOf("disk99s1", LAYOUT)).toBeUndefined();
  });

  test("a layout that loops does not recurse forever", () => {
    const loop = {
      partitions: new Map(),
      containerStores: new Map([["a", ["b"]], ["b", ["a"]]]),
      volumeContainer: new Map([["a", "b"], ["b", "a"]]),
    };
    expect(wholeDiskOf("a", loop)).toBeUndefined();
  });
});

describe("readDarwinPartitions", () => {
  test("gives each APFS partition every mount of its container, / first", () => {
    const [isc, main, recovery] = readDarwinPartitions("disk0", LAYOUT, MOUNTS);
    expect(main).toEqual({
      id: "disk0s2",
      devicePath: "/dev/disk0s2",
      sizeBytes: 994662584320,
      filesystem: "apfs",
      mounts: ["/", "/System/Volumes/Data", "/System/Volumes/Preboot", "/System/Volumes/Update", "/System/Volumes/VM"]
        .map((mountPoint) => ({ mountPoint, filesystem: "apfs" })),
    });
    expect(isc!.mounts.map((m) => m.mountPoint)).toEqual([
      "/System/Volumes/Hardware", "/System/Volumes/iSCPreboot", "/System/Volumes/xarts",
    ]);
    // Recovery is a container nothing mounts in normal use.
    expect(recovery).toMatchObject({ id: "disk0s3", filesystem: "apfs", mounts: [] });
  });

  test("names an unmounted partition's filesystem only when its type allows one answer", () => {
    const layout = {
      partitions: new Map([["disk6", [
        { id: "disk6s1", content: "EFI", sizeBytes: 1 },
        { id: "disk6s2", content: "Microsoft Basic Data", sizeBytes: 2 },
      ]]]),
      containerStores: new Map(),
      volumeContainer: new Map(),
    };
    const [efi, data] = readDarwinPartitions("disk6", layout, []);
    expect(efi!.filesystem).toBe("msdos");
    // exFAT, FAT32 or NTFS: nothing short of a mount says which.
    expect(data!.filesystem).toBeUndefined();
    const mounted = readDarwinPartitions("disk6", layout, [{ id: "disk6s2", mountPoint: "/Volumes/USB", filesystem: "exfat" }]);
    expect(mounted[1]).toMatchObject({ filesystem: "exfat", mounts: [{ mountPoint: "/Volumes/USB", filesystem: "exfat" }] });
  });
});

describe("darwinDiskKind and darwinDiskModel", () => {
  const base: DarwinBlockDevice = {
    id: "disk9", capacityBytes: 1, removable: false, ejectable: false,
    stats: { readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0, readTimeNs: 0, writeTimeNs: 0 },
  };

  test("reads the kind from what the drive and its class say", () => {
    expect(darwinDiskKind(DEVICES[0]!)).toBe("nvme");
    expect(darwinDiskKind({ ...base, ioClass: "IONVMeBlockStorageDevice", interconnect: "PCI-Express" })).toBe("nvme");
    expect(darwinDiskKind({ ...base, interconnect: "Secure Digital", removable: true })).toBe("sd");
    expect(darwinDiskKind({ ...base, ioClass: "IODVDBlockStorageDevice" })).toBe("optical");
    expect(darwinDiskKind({ ...base, interconnect: "USB", removable: true })).toBe("thumb");
    expect(darwinDiskKind({ ...base, interconnect: "USB", medium: "Solid State" })).toBe("ssd");
    expect(darwinDiskKind({ ...base, interconnect: "SATA", medium: "Rotational" })).toBe("hdd");
    expect(darwinDiskKind(base)).toBe("unknown");
  });

  test("joins vendor and product unless the vendor is empty, generic or repeated", () => {
    expect(darwinDiskModel(DEVICES[0]!)).toBe("APPLE SSD AP1024R");
    expect(darwinDiskModel({ vendor: "Samsung", product: "Portable SSD T7" })).toBe("Samsung Portable SSD T7");
    expect(darwinDiskModel({ vendor: "Apple", product: "APPLE SSD AP0512Q" })).toBe("APPLE SSD AP0512Q");
    expect(darwinDiskModel({ vendor: "ATA", product: "WDC WD40EFRX" })).toBe("WDC WD40EFRX");
    expect(darwinDiskModel({ vendor: "Kingston" })).toBe("Kingston");
    expect(darwinDiskModel({})).toBeUndefined();
  });
});

describe("buildDarwinDiskInventory", () => {
  test("describes the SSD as the system disk, with its three partitions", () => {
    const [ssd, ...rest] = buildDarwinDiskInventory(DEVICES, LAYOUT, MOUNTS);
    expect(rest).toEqual([]);
    expect(ssd).toMatchObject({
      id: "disk0", model: "APPLE SSD AP1024R", kind: "nvme", capacityBytes: 1000555581440,
      systemDisk: true, removable: false, serial: "0000000000000000",
    });
    expect(ssd!.partitions?.map((p) => p.id)).toEqual(["disk0s1", "disk0s2", "disk0s3"]);
  });

  test("lists exactly the drives the tick measures — the disk image is in neither", () => {
    expect(buildDarwinDiskInventory(DEVICES, LAYOUT, MOUNTS).map((d) => d.id)).toEqual(DEVICES.map((d) => d.id));
  });

  test("without diskutil, partitions are unknown rather than none, and no disk is the system one", () => {
    const [ssd] = buildDarwinDiskInventory(DEVICES, undefined, MOUNTS);
    expect("partitions" in ssd!).toBe(false);
    expect(ssd!.systemDisk).toBe(false);
  });

  test("a USB SSD is removable because it can leave the Mac, not because its media can", () => {
    const usb: DarwinBlockDevice = { ...DEVICES[0]!, id: "disk6", ioClass: "IOSCSIPeripheralDeviceType00", ejectable: true };
    expect(buildDarwinDiskInventory([usb], LAYOUT, MOUNTS)[0]!.removable).toBe(true);
  });
});

describe("readDarwinDiskInventory", () => {
  const reads = (over: Partial<DarwinToolReads> = {}): DarwinToolReads => {
    const at = (value: unknown) => async () => ({ value, atSec: 1 }) as never;
    return {
      blockDevices: at(parsePlistXml(darwinFixture("ioreg-block-devices.xml"))),
      diskutilList: at(parsePlistXml(darwinFixture("diskutil-list.plist"))),
      mounts: at(darwinFixture("mount.txt")),
      accelerators: async () => undefined,
      netstat: async () => undefined,
      ifconfig: async () => undefined,
      serviceOrder: async () => undefined,
      ...over,
    };
  };

  test("fills every mount's usage from statfs, which APFS answers for the whole container", async () => {
    const asked: string[] = [];
    const block = 4096;
    const [ssd] = await readDarwinDiskInventory(reads(), async (path) => {
      asked.push(path);
      return { bsize: block, blocks: 1000, bfree: 250, bavail: 250 };
    });
    const main = ssd!.partitions![1]!;
    expect(main.mounts[0]).toMatchObject({ mountPoint: "/", usedBytes: 750 * block, totalBytes: 1000 * block });
    expect(asked).toContain("/System/Volumes/Data");
    // Only mounts of the drives listed: the disk image's volume is never asked.
    expect(asked).not.toContain("/Volumes/PPMFixture");
  });

  test("a mount that statfs refuses has no figures rather than zeroes", async () => {
    const [ssd] = await readDarwinDiskInventory(reads(), async () => { throw new Error("EACCES"); });
    expect(ssd!.partitions![1]!.mounts[0]).toEqual({ mountPoint: "/", filesystem: "apfs" });
  });

  test("with ioreg failing there are no drives, and nothing throws", async () => {
    expect(await readDarwinDiskInventory(reads({ blockDevices: async () => undefined }), async () => {
      throw new Error("unreached");
    })).toEqual([]);
  });
});
