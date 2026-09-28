/**
 * Partitions of a whole disk, with what is mounted on them and how full it is —
 * Mission Center's Partitions section on the drive page.
 *
 * Mission Center asks udisks2 over D-Bus. This reads sysfs for the partition
 * list, `/proc/self/mountinfo` for the mounts and `statfs` for the usage, so it
 * needs neither a system bus nor root.
 *
 * The usage figures are read with the ASYNC `statfs`, deliberately: PPM serves
 * every request and every chat session from one event loop, and `statfsSync` on
 * a mount whose device is spinning up (or an autofs mount that is cold) blocks
 * that loop for as long as the kernel takes. It is also why this is not on the
 * 2 s tick — it belongs to the inventory, which is fetched on demand.
 */
import type { DiskInfo, PartitionInfo, PartitionMount } from "../../types/system-hardware.ts";
import { readAttr, readNumber, realLinuxFs, type LinuxFs } from "./linux-fs.ts";
import { readUdevProperties, udevValue } from "./udev-db.ts";
import { SYS_BLOCK } from "./disk-devices-linux.ts";

const SECTOR_BYTES = 512;
const MOUNTINFO = "/proc/self/mountinfo";

/** One mount as `/proc/self/mountinfo` describes it. */
export interface MountEntry {
  /** mountinfo's major:minor. For ext4 this is the block device's own, but a
   *  filesystem that can span devices registers an ANONYMOUS one instead — every
   *  btrfs mount on this host reports `0:35` rather than `259:2` — so this alone
   *  finds no mount at all on a btrfs root, which is most Arch installs. */
  deviceId: string;
  /** The device as the kernel records it, "/dev/nvme0n1p2". This is what matches
   *  a btrfs partition; `deviceId` is what still matches when the source is a
   *  label or a stacked device. Both are needed. */
  source: string;
  /** Which part of the filesystem is mounted: "/" for the whole thing, "/@home"
   *  for a btrfs subvolume, a directory for a bind mount. */
  root: string;
  mountPoint: string;
  filesystem: string;
}

/**
 * mountinfo's variable-length optional-fields group ends at a literal `-`, so the
 * tail cannot be indexed from the start of the line. Splitting on the separator
 * first is what makes `fstype` findable at all.
 *
 * Paths are escaped by the kernel — a mount under `/mnt/my drive` arrives as
 * `/mnt/my\040drive`, and leaving it that way means the statfs below fails on
 * exactly the mounts whose names have spaces.
 */
export function parseMountInfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const head = line.slice(0, sep).split(" ");
    const tail = line.slice(sep + 3).split(" ");
    const deviceId = head[2];
    const root = head[3];
    const mountPoint = head[4];
    const filesystem = tail[0];
    if (!deviceId || !root || !mountPoint || !filesystem) continue;
    out.push({
      deviceId,
      source: unescapeMountPath(tail[1] ?? ""),
      root: unescapeMountPath(root),
      mountPoint: unescapeMountPath(mountPoint),
      filesystem,
    });
  }
  return out;
}

/** The four sequences the kernel escapes: space, tab, newline, backslash. */
export function unescapeMountPath(path: string): string {
  return path.replace(/\\(040|011|012|134)/g, (_, code) =>
    ({ "040": " ", "011": "\t", "012": "\n", "134": "\\" })[code as string] ?? _);
}

/** Partition directories of a whole disk: sysfs nests them under the disk and
 *  marks each with a `partition` attribute, which is what tells `sda1` apart from
 *  `queue` or `holders`. */
export function listPartitions(diskId: string, fs: LinuxFs = realLinuxFs): string[] {
  return (fs.list(`${SYS_BLOCK}/${diskId}`) ?? [])
    .filter((name) => fs.exists(`${SYS_BLOCK}/${diskId}/${name}/partition`))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** The static half: everything but the usage, which needs a syscall per mount. */
export function readPartitions(
  diskId: string,
  fs: LinuxFs = realLinuxFs,
  mounts: MountEntry[] = parseMountInfo(fs.read(MOUNTINFO) ?? ""),
): PartitionInfo[] {
  return listPartitions(diskId, fs).map((id) => {
    const base = `${SYS_BLOCK}/${diskId}/${id}`;
    const deviceId = readAttr(fs, `${base}/dev`);
    const udev = readUdevProperties(deviceId ? `b${deviceId}` : "", fs.read);
    const sectors = readNumber(fs, `${base}/size`) ?? 0;
    const devicePath = `/dev/${id}`;
    const mine = mounts.filter((m) => (deviceId && m.deviceId === deviceId) || m.source === devicePath);
    // udev knows the type even for a partition nothing has mounted, which is the
    // case the mountinfo scan cannot answer at all.
    const filesystem = udevValue(udev, "ID_FS_TYPE") ?? mine[0]?.filesystem;
    return {
      id,
      devicePath,
      sizeBytes: sectors * SECTOR_BYTES,
      ...(filesystem ? { filesystem } : {}),
      mounts: mine.map((m) => ({ mountPoint: m.mountPoint, filesystem: m.filesystem })),
    };
  });
}

export type StatfsReader = (path: string) => Promise<{ blocks: number; bavail: number; bfree: number; bsize: number }>;

const realStatfs: StatfsReader = async (path) => {
  const { statfs } = await import("node:fs/promises");
  return statfs(path) as unknown as ReturnType<StatfsReader> extends Promise<infer T> ? T : never;
};

/**
 * `used` is computed against the blocks a non-root user may actually have, not
 * against the total: ext4 reserves 5% for root, so `blocks - bfree` reports a
 * fresh filesystem as several percent full while `df` says 1%. This is `df`'s own
 * arithmetic — total is what you can use plus what is used.
 */
export function usageFromStatfs(s: { blocks: number; bavail: number; bfree: number; bsize: number }): PartitionMount {
  const used = (s.blocks - s.bfree) * s.bsize;
  const total = used + s.bavail * s.bsize;
  return { mountPoint: "", filesystem: "", usedBytes: used, totalBytes: total };
}

/**
 * Fills in every mount's usage, in parallel. A mount that refuses is left with no
 * figures rather than zeroes — an unreadable filesystem is not an empty one.
 */
export async function attachPartitionUsage(
  disks: DiskInfo[],
  statfs: StatfsReader = realStatfs,
): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const disk of disks) {
    for (const part of disk.partitions ?? []) {
      for (const mount of part.mounts) {
        jobs.push(
          statfs(mount.mountPoint)
            .then((s) => {
              const { usedBytes, totalBytes } = usageFromStatfs(s);
              mount.usedBytes = usedBytes;
              mount.totalBytes = totalBytes;
            })
            .catch(() => {}),
        );
      }
    }
  }
  await Promise.all(jobs);
}
