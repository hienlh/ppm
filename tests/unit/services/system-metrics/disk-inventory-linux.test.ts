import { describe, test, expect } from "bun:test";
import {
  blockDeviceKey,
  diskKind,
  diskModel,
  findSystemDisk,
  readDiskInventory,
  rootMountSource,
} from "../../../../src/services/system-metrics/disk-inventory-linux.ts";
import { parseUdevProperties } from "../../../../src/services/system-metrics/udev-db.ts";
import { fakeLinuxFs } from "./fixtures/fake-linux-fs.ts";

const udev = (text: string) => parseUdevProperties(text);

/** A real btrfs-on-NVMe root line off this repo's dev host. */
const MOUNTINFO = [
  "38 41 0:7 / /dev rw,nosuid shared:2 - devtmpfs devtmpfs rw,size=32684844k,mode=755",
  "41 1 0:35 /@ / rw,noatime shared:1 - btrfs /dev/nvme0n1p2 rw,compress=zstd:1,subvol=/@",
  "42 38 0:26 / /dev/shm rw,nosuid shared:3 - tmpfs tmpfs rw,inode64",
].join("\n");

describe("rootMountSource", () => {
  test("the source device of the / line, past the optional-field separator", () => {
    expect(rootMountSource(MOUNTINFO)).toBe("/dev/nvme0n1p2");
  });

  test("a line with no optional fields still resolves (the separator moves)", () => {
    expect(rootMountSource("41 1 259:2 / / rw,relatime - ext4 /dev/sda2 rw")).toBe("/dev/sda2");
  });

  test("a / that is not a block mount (overlayfs, tmpfs) has no disk", () => {
    expect(rootMountSource("41 1 0:1 / / rw - overlay overlay rw,lowerdir=/a")).toBeUndefined();
    expect(rootMountSource("")).toBeUndefined();
  });
});

describe("findSystemDisk", () => {
  test("a partition resolves to the disk that holds it", () => {
    const fs = fakeLinuxFs({
      files: { "/proc/self/mountinfo": MOUNTINFO },
      real: {
        "/dev/nvme0n1p2": "/dev/nvme0n1p2",
        "/sys/class/block/nvme0n1p2": "/sys/devices/pci0000:00/nvme/nvme0/nvme0n1/nvme0n1p2",
        "/sys/class/block/nvme0n1": "/sys/devices/pci0000:00/nvme/nvme0/nvme0n1",
      },
      present: [
        "/sys/devices/pci0000:00/nvme/nvme0/nvme0n1/nvme0n1p2/partition",
        "/sys/block/nvme0n1",
      ],
    });
    expect(findSystemDisk(fs)).toBe("nvme0n1");
  });

  test("a mapper device (LUKS, LVM) is followed through slaves", () => {
    const fs = fakeLinuxFs({
      files: { "/proc/self/mountinfo": "41 1 253:0 / / rw - ext4 /dev/mapper/root rw" },
      real: {
        "/dev/mapper/root": "/dev/dm-0",
        "/sys/class/block/dm-0": "/sys/devices/virtual/block/dm-0",
        "/sys/class/block/sda3": "/sys/devices/pci/ata1/host0/sda/sda3",
        "/sys/class/block/sda": "/sys/devices/pci/ata1/host0/sda",
      },
      dirs: { "/sys/devices/virtual/block/dm-0/slaves": ["sda3"] },
      present: ["/sys/devices/pci/ata1/host0/sda/sda3/partition", "/sys/block/sda"],
    });
    expect(findSystemDisk(fs)).toBe("sda");
  });

  test("no root device is undefined, not a guess", () => {
    expect(findSystemDisk(fakeLinuxFs({}))).toBeUndefined();
  });
});

describe("diskModel", () => {
  test("SATA's generic 'ATA' vendor is dropped — Mission Center prints it", () => {
    const fs = fakeLinuxFs({
      files: { "/sys/block/sda/device/model": "TEAM T253X1240G ", "/sys/block/sda/device/vendor": "ATA     " },
    });
    expect(diskModel("sda", fs, udev(""))).toBe("TEAM T253X1240G");
  });

  test("a real vendor is prefixed unless the model already starts with it", () => {
    const withVendor = fakeLinuxFs({
      files: { "/sys/block/sdb/device/model": "ST4000DM004", "/sys/block/sdb/device/vendor": "Seagate" },
    });
    expect(diskModel("sdb", withVendor, udev(""))).toBe("Seagate ST4000DM004");

    const repeated = fakeLinuxFs({
      files: { "/sys/block/sdb/device/model": "Seagate ST4000DM004", "/sys/block/sdb/device/vendor": "Seagate" },
    });
    expect(diskModel("sdb", repeated, udev(""))).toBe("Seagate ST4000DM004");
  });

  test("no sysfs model falls back to udev, whose spaces are underscores", () => {
    expect(diskModel("sda", fakeLinuxFs({}), udev("E:ID_MODEL=TEAM_T253X1240G"))).toBe("TEAM T253X1240G");
  });

  test("a device reporting neither has no model rather than an empty string", () => {
    expect(diskModel("sda", fakeLinuxFs({}), udev(""))).toBeUndefined();
  });
});

describe("diskKind", () => {
  test("the name decides for nvme, optical and mmc", () => {
    expect(diskKind("nvme0n1", fakeLinuxFs({}), udev(""))).toBe("nvme");
    expect(diskKind("sr0", fakeLinuxFs({}), udev(""))).toBe("optical");
    const sd = fakeLinuxFs({
      dirs: { "/sys/class/mmc_host/mmc0": ["mmc0:0001"] },
      files: { "/sys/class/mmc_host/mmc0/mmc0:0001/type": "SD\n" },
    });
    expect(diskKind("mmcblk0", sd, udev(""))).toBe("sd");
    const emmc = fakeLinuxFs({
      dirs: { "/sys/class/mmc_host/mmc1": ["mmc1:0001"] },
      files: { "/sys/class/mmc_host/mmc1/mmc1:0001/type": "MMC" },
    });
    expect(diskKind("mmcblk1", emmc, udev(""))).toBe("emmc");
  });

  test("rotational tells SSD from HDD, as it does for udisks2", () => {
    const ssd = fakeLinuxFs({ files: { "/sys/block/sda/queue/rotational": "0" } });
    const hdd = fakeLinuxFs({ files: { "/sys/block/sdb/queue/rotational": "1" } });
    expect(diskKind("sda", ssd, udev(""))).toBe("ssd");
    expect(diskKind("sdb", hdd, udev(""))).toBe("hdd");
    expect(diskKind("sdc", fakeLinuxFs({}), udev(""))).toBe("unknown");
  });

  test("removable on the USB bus is a thumb drive, which is udisks2's answer too", () => {
    const fs = fakeLinuxFs({
      files: { "/sys/block/sdc/removable": "1", "/sys/block/sdc/queue/rotational": "0" },
    });
    expect(diskKind("sdc", fs, udev("E:ID_BUS=usb"))).toBe("thumb");
    // Removable on a non-USB bus is still just a disk.
    expect(diskKind("sdc", fs, udev("E:ID_BUS=ata"))).toBe("ssd");
  });
});

describe("readDiskInventory", () => {
  const fs = fakeLinuxFs({
    files: {
      "/proc/self/mountinfo": MOUNTINFO,
      "/sys/block/nvme0n1/size": "500118192",
      "/sys/block/nvme0n1/dev": "259:0",
      "/sys/block/nvme0n1/removable": "0",
      "/sys/block/nvme0n1/device/model": "THNSF5256GPUK TOSHIBA                   ",
      "/sys/block/nvme0n1/device/serial": "67LS10VBTALT        ",
      "/sys/block/nvme0n1/wwid": "eui.00080d020028e499",
      "/sys/block/sda/size": "468862128",
      "/sys/block/sda/dev": "8:0",
      "/sys/block/sda/removable": "0",
      "/sys/block/sda/queue/rotational": "0",
      "/sys/block/sda/device/model": "TEAM T253X1240G ",
      "/sys/block/sda/device/vendor": "ATA     ",
      "/run/udev/data/b8:0": "E:ID_BUS=ata\nE:ID_SERIAL_SHORT=EB8F0794142F00265765\nE:ID_ATA_ROTATION_RATE_RPM=0\n",
      "/run/udev/data/b259:0": "E:ID_WWN=eui.00080d020028e499\n",
    },
    dirs: { "/sys/block": ["nvme0n1", "sda", "zram0"] },
    real: {
      "/dev/nvme0n1p2": "/dev/nvme0n1p2",
      "/sys/class/block/nvme0n1p2": "/sys/devices/pci/nvme/nvme0n1/nvme0n1p2",
      "/sys/class/block/nvme0n1": "/sys/devices/pci/nvme/nvme0n1",
    },
    present: ["/sys/devices/pci/nvme/nvme0n1/nvme0n1p2/partition", "/sys/block/nvme0n1"],
  });

  test("one entry per whole disk, with the root's drive flagged", () => {
    const disks = readDiskInventory(fs);
    expect(disks.map((d) => d.id)).toEqual(["nvme0n1", "sda"]);
    expect(disks.map((d) => d.systemDisk)).toEqual([true, false]);
  });

  test("capacity is sectors x 512, not the raw sector count", () => {
    expect(readDiskInventory(fs)[0]?.capacityBytes).toBe(500118192 * 512);
  });

  test("padded sysfs strings are trimmed and a 0 rpm rate is left off", () => {
    const [nvme, sda] = readDiskInventory(fs);
    expect(nvme?.model).toBe("THNSF5256GPUK TOSHIBA");
    expect(nvme?.serial).toBe("67LS10VBTALT");
    expect(nvme?.wwn).toBe("eui.00080d020028e499");
    expect(sda?.serial).toBe("EB8F0794142F00265765");
    expect("rotationRpm" in (sda ?? {})).toBe(false);
  });

  test("a padded T10 wwid is collapsed — it is shown to a person, not compared", () => {
    const t10 = fakeLinuxFs({
      dirs: { "/sys/block": ["sda"] },
      files: {
        "/sys/block/sda/size": "1",
        "/sys/block/sda/dev": "8:0",
        "/sys/block/sda/device/wwid": "t10.ATA     TEAM T253X1240G                    EB8F0794142F00265765",
      },
    });
    expect(readDiskInventory(t10)[0]?.wwn).toBe("t10.ATA TEAM T253X1240G EB8F0794142F00265765");
  });

  test("udev keys a block device by b<major>:<minor>", () => {
    expect(blockDeviceKey("sda", fs)).toBe("b8:0");
  });
});
