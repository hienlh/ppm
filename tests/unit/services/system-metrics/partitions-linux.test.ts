/**
 * Partitions, their mounts, and how full each filesystem is.
 *
 * The load-bearing finding here is that `/proc/self/mountinfo`'s major:minor is
 * NOT the block device's for a filesystem that can span devices: every btrfs
 * mount on the dev host reports the anonymous `0:35` while the partition's sysfs
 * `dev` says `259:2`. Matching on that field alone found no mount at all on a
 * btrfs root — i.e. on most Arch and Fedora installs — and the bug is invisible
 * on an ext4 box, which is why both keys are tested explicitly.
 */
import { describe, test, expect } from "bun:test";
import {
  attachPartitionUsage,
  listPartitions,
  parseMountInfo,
  readPartitions,
  unescapeMountPath,
  usageFromStatfs,
} from "../../../../src/services/system-metrics/partitions-linux.ts";
import { fakeLinuxFs } from "./fixtures/fake-linux-fs.ts";
import type { DiskInfo } from "../../../../src/types/system-hardware.ts";

/** Real lines off this repo's dev host, btrfs root and all. */
const MOUNTINFO = [
  "41 1 0:35 /@ / rw,noatime shared:1 - btrfs /dev/nvme0n1p2 rw,subvol=/@",
  "38 41 0:7 / /dev rw,nosuid shared:2 - devtmpfs devtmpfs rw,mode=755",
  "48 41 259:1 / /boot rw,relatime shared:9 - vfat /dev/nvme0n1p1 rw,fmask=0022",
  "52 41 0:35 /@log /var/log rw,noatime shared:12 - btrfs /dev/nvme0n1p2 rw,subvol=/@log",
  "60 41 0:41 /@home /home rw,noatime shared:20 - btrfs /dev/sda1 rw,subvol=/@home",
].join("\n");

describe("parseMountInfo", () => {
  test("reads past the variable-length optional fields to the fstype and source", () => {
    const boot = parseMountInfo(MOUNTINFO).find((m) => m.mountPoint === "/boot");
    expect(boot).toEqual({
      deviceId: "259:1", source: "/dev/nvme0n1p1", root: "/", mountPoint: "/boot", filesystem: "vfat",
    });
  });

  test("a line with no optional fields parses too — the separator moves", () => {
    const [only] = parseMountInfo("41 1 259:2 / / rw,relatime - ext4 /dev/sda2 rw");
    expect(only?.source).toBe("/dev/sda2");
    expect(only?.filesystem).toBe("ext4");
  });

  test("ignores anything with no ' - ' separator, including a blank tail", () => {
    expect(parseMountInfo("")).toEqual([]);
    expect(parseMountInfo("garbage\n\n41 1 0:1 / /x rw")).toEqual([]);
  });

  test("unescapes the kernel's octal in a mount point, or statfs opens the wrong path", () => {
    const [m] = parseMountInfo("41 1 8:1 / /mnt/my\\040drive rw - ext4 /dev/sdb1 rw");
    expect(m?.mountPoint).toBe("/mnt/my drive");
  });
});

describe("unescapeMountPath", () => {
  test("handles all four sequences the kernel writes", () => {
    expect(unescapeMountPath("a\\040b\\011c\\012d\\134e")).toBe("a b\tc\nd\\e");
  });

  test("leaves an unrelated backslash alone", () => {
    expect(unescapeMountPath("/mnt/\\999")).toBe("/mnt/\\999");
  });
});

describe("usageFromStatfs", () => {
  /** df's arithmetic: used is against total blocks, but the total offered is what
   *  a non-root user can reach — ext4 reserves 5% for root, and counting that as
   *  free reports a fresh filesystem as several percent full. */
  test("excludes root-reserved blocks from the total, as df does", () => {
    const u = usageFromStatfs({ blocks: 100, bfree: 50, bavail: 45, bsize: 1024 });
    expect(u.usedBytes).toBe(50 * 1024);
    expect(u.totalBytes).toBe((50 + 45) * 1024);
    expect(u.totalBytes).toBeLessThan(100 * 1024);
  });

  test("a full filesystem is 100%, not over it", () => {
    const u = usageFromStatfs({ blocks: 100, bfree: 0, bavail: 0, bsize: 4096 });
    expect(u.usedBytes).toBe(u.totalBytes);
  });
});

const fs = () => fakeLinuxFs({
  dirs: {
    "/sys/block/sda": ["sda1", "sda2", "queue", "holders", "power"],
    "/sys/block/nvme0n1": ["nvme0n1p1", "nvme0n1p2"],
  },
  files: {
    "/sys/block/sda/sda1/dev": "8:1\n",
    "/sys/block/sda/sda1/size": "468858880\n",
    "/sys/block/sda/sda2/dev": "8:2\n",
    "/sys/block/sda/sda2/size": "2048\n",
    "/sys/block/nvme0n1/nvme0n1p1/dev": "259:1\n",
    "/sys/block/nvme0n1/nvme0n1p1/size": "8388608\n",
    "/run/udev/data/b8:1": "E:ID_FS_TYPE=btrfs\n",
    "/run/udev/data/b8:2": "E:ID_FS_TYPE=swap\n",
  },
  present: [
    "/sys/block/sda/sda1/partition", "/sys/block/sda/sda2/partition",
    "/sys/block/nvme0n1/nvme0n1p1/partition", "/sys/block/nvme0n1/nvme0n1p2/partition",
  ],
});

describe("listPartitions", () => {
  test("only the entries sysfs marks as partitions, never queue or holders", () => {
    expect(listPartitions("sda", fs())).toEqual(["sda1", "sda2"]);
  });

  test("orders them numerically, so sda10 does not sort before sda2", () => {
    const many = fakeLinuxFs({
      dirs: { "/sys/block/sda": ["sda10", "sda2", "sda1"] },
      present: ["/sys/block/sda/sda10/partition", "/sys/block/sda/sda2/partition", "/sys/block/sda/sda1/partition"],
    });
    expect(listPartitions("sda", many)).toEqual(["sda1", "sda2", "sda10"]);
  });

  test("a disk with no partition table yields an empty list, not an error", () => {
    expect(listPartitions("sdz", fs())).toEqual([]);
  });
});

describe("readPartitions", () => {
  const mounts = parseMountInfo(MOUNTINFO);

  test("finds a btrfs mount by its SOURCE, which its major:minor cannot", () => {
    const [sda1] = readPartitions("sda", fs(), mounts);
    // The proof the anonymous-device trap is handled: mountinfo says 0:41 here
    // while sysfs says 8:1, so a major:minor match alone returns nothing.
    expect(mounts.find((m) => m.mountPoint === "/home")?.deviceId).not.toBe("8:1");
    expect(sda1?.mounts.map((m) => m.mountPoint)).toEqual(["/home"]);
  });

  test("finds an ext4-style mount by its major:minor", () => {
    const [p1] = readPartitions("nvme0n1", fs(), mounts);
    expect(p1?.mounts).toEqual([{ mountPoint: "/boot", filesystem: "vfat" }]);
  });

  test("lists every mount of one partition — btrfs subvolumes are several", () => {
    const nvme = readPartitions("nvme0n1", fakeLinuxFs({
      dirs: { "/sys/block/nvme0n1": ["nvme0n1p2"] },
      files: { "/sys/block/nvme0n1/nvme0n1p2/dev": "259:2\n", "/sys/block/nvme0n1/nvme0n1p2/size": "10\n" },
      present: ["/sys/block/nvme0n1/nvme0n1p2/partition"],
    }), mounts);
    expect(nvme[0]?.mounts.map((m) => m.mountPoint)).toEqual(["/", "/var/log"]);
  });

  test("names the filesystem of a partition nothing has mounted, from udev", () => {
    const [, swap] = readPartitions("sda", fs(), mounts);
    expect(swap?.filesystem).toBe("swap");
    expect(swap?.mounts).toEqual([]);
  });

  test("reports the size the partition table says, in bytes", () => {
    const [sda1] = readPartitions("sda", fs(), mounts);
    expect(sda1?.sizeBytes).toBe(468858880 * 512);
    expect(sda1?.devicePath).toBe("/dev/sda1");
  });
});

describe("attachPartitionUsage", () => {
  const disk = (): DiskInfo => ({
    id: "sda", kind: "ssd", capacityBytes: 1, systemDisk: false, removable: false,
    partitions: [{
      id: "sda1", devicePath: "/dev/sda1", sizeBytes: 1,
      mounts: [{ mountPoint: "/home", filesystem: "btrfs" }],
    }],
  });

  test("fills in the usage of every mount", async () => {
    const disks = [disk()];
    await attachPartitionUsage(disks, async () => ({ blocks: 100, bfree: 40, bavail: 40, bsize: 1000 }));
    expect(disks[0]!.partitions![0]!.mounts[0]).toEqual({
      mountPoint: "/home", filesystem: "btrfs", usedBytes: 60_000, totalBytes: 100_000,
    });
  });

  /** A filesystem we could not read is not an empty one — the em-dash contract. */
  test("leaves a mount that refuses with no figures rather than zeroes", async () => {
    const disks = [disk()];
    await attachPartitionUsage(disks, async () => { throw new Error("EACCES"); });
    const mount = disks[0]!.partitions![0]!.mounts[0]!;
    expect(mount.usedBytes).toBeUndefined();
    expect(mount.totalBytes).toBeUndefined();
  });

  test("one mount failing does not stop the others", async () => {
    const disks = [disk()];
    disks[0]!.partitions![0]!.mounts.push({ mountPoint: "/boot", filesystem: "vfat" });
    await attachPartitionUsage(disks, async (path) => {
      if (path === "/home") throw new Error("nope");
      return { blocks: 10, bfree: 5, bavail: 5, bsize: 100 };
    });
    expect(disks[0]!.partitions![0]!.mounts[0]!.usedBytes).toBeUndefined();
    expect(disks[0]!.partitions![0]!.mounts[1]!.usedBytes).toBe(500);
  });

  test("a disk with no partitions at all is not an error", async () => {
    await attachPartitionUsage([{ id: "sr0", kind: "unknown", capacityBytes: 0, systemDisk: false, removable: true }] as DiskInfo[], async () => {
      throw new Error("should not be called");
    });
  });
});
