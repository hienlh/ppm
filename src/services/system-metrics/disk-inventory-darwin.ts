/**
 * Static facts about each drive on macOS: model, kind, capacity, serial, which one
 * holds the system, and its partitions with what is mounted on them.
 *
 * The drive list is the tick's own `ioreg` parse, so the inventory names exactly
 * the drives the tick measures — the client refetches the inventory for as long
 * as a tick names a drive it does not know. The partition table comes from
 * `diskutil list -plist` and the mounts from `mount`, the Mac's mountinfo.
 *
 * APFS adds a layer Linux does not have between a partition and a mount: the
 * partition is the physical store of a CONTAINER, and it is the container's
 * volumes that are mounted — the internal SSD's one big partition carries `/`,
 * `/System/Volumes/Data`, Preboot, VM and Update. Every volume shares the
 * container's free space, so statfs on any of them answers for the whole
 * container, and the partition gets one bar, the way a btrfs partition with
 * several subvolumes does on Linux.
 */
import type { DiskInfo, DiskKind, PartitionInfo } from "../../types/system-hardware.ts";
import { parseBlockDevices, type DarwinBlockDevice } from "./disk-devices-darwin.ts";
import type { DarwinToolReads } from "./darwin-tool-reads.ts";
import { attachPartitionUsage, type StatfsReader } from "./partitions-linux.ts";
import { plistArray, plistDict, plistNumber, plistString, type PlistDict, type PlistValue } from "./plist-xml.ts";

/** How far to follow volume → container → store before giving up. Two hops is
 *  the real depth; the bound only stops a malformed layout from looping. */
const MAX_DEPTH = 8;

/** The kernel's transport names are not manufacturers — Linux's rule. */
const GENERIC_VENDORS = new Set(["ATA", "SATA", "NVME", "USB", "SCSI"]);

/** Partition types that name exactly one filesystem, for a partition nothing has
 *  mounted — the question udev's `ID_FS_TYPE` answers on Linux. "Microsoft Basic
 *  Data" is deliberately absent: it is exFAT, FAT32 or NTFS, and only a mount says
 *  which. Names are the ones `mount` prints. */
const CONTENT_FILESYSTEMS: Record<string, string> = {
  Apple_APFS: "apfs",
  Apple_APFS_ISC: "apfs",
  Apple_APFS_Recovery: "apfs",
  Apple_HFS: "hfs",
  Apple_HFSX: "hfs",
  EFI: "msdos",
};

export interface DiskutilPartition {
  id: string;
  /** The partition type: "Apple_APFS", "EFI", "Microsoft Basic Data", … */
  content?: string;
  sizeBytes: number;
}

/** The part of `diskutil list -plist` that says what sits on what. */
export interface DiskutilLayout {
  /** Whole disk → its partitions, in table order. A container is listed too,
   *  with none. */
  partitions: Map<string, DiskutilPartition[]>;
  /** APFS container → the partitions it lives on (two for a Fusion drive). */
  containerStores: Map<string, string[]>;
  /** APFS volume, or a snapshot mounted in its place, → its container. */
  volumeContainer: Map<string, string>;
}

export function parseDiskutilList(root: PlistValue | undefined): DiskutilLayout {
  const layout: DiskutilLayout = { partitions: new Map(), containerStores: new Map(), volumeContainer: new Map() };
  for (const value of plistArray(plistDict(root)?.AllDisksAndPartitions) ?? []) {
    const entry = plistDict(value);
    const id = plistString(entry?.DeviceIdentifier);
    if (!entry || !id) continue;
    const stores = ids(entry.APFSPhysicalStores, "DeviceIdentifier");
    if (stores.length > 0) {
      layout.containerStores.set(id, stores);
      for (const volume of dicts(entry.APFSVolumes)) {
        const volumeId = plistString(volume.DeviceIdentifier);
        if (volumeId) layout.volumeContainer.set(volumeId, id);
        for (const snapshot of ids(volume.MountedSnapshots, "SnapshotBSD")) layout.volumeContainer.set(snapshot, id);
      }
    }
    layout.partitions.set(id, dicts(entry.Partitions).flatMap((p) => {
      const partitionId = plistString(p.DeviceIdentifier);
      if (!partitionId) return [];
      const content = plistString(p.Content);
      return [{ id: partitionId, ...(content ? { content } : {}), sizeBytes: plistNumber(p.Size) ?? 0 }];
    }));
  }
  return layout;
}

/** One `/dev` mount as `mount` prints it. */
export interface DarwinMount {
  /** BSD name of the mounted device: "disk3s1", "disk3s3s1" for a snapshot. */
  id: string;
  mountPoint: string;
  filesystem: string;
}

/**
 * `mount` prints `<source> on <point> (<fstype>, <options…>)`, with the path
 * unescaped — `/Volumes/My Drive (1)` arrives with its spaces and its own
 * parentheses — so the point is everything up to the LAST parenthesised group.
 * Anything not backed by a `/dev` node (devfs, autofs maps) is not a partition.
 */
export function parseMountTable(text: string): DarwinMount[] {
  const out: DarwinMount[] = [];
  for (const line of text.split("\n")) {
    const m = /^\/dev\/(\S+) on (.+) \(([^,()]+)(?:,[^()]*)?\)$/.exec(line.trim());
    if (m) out.push({ id: m[1]!, mountPoint: m[2]!, filesystem: m[3]!.trim() });
  }
  return out;
}

/** "vendor product", with a generic or repeated vendor dropped — Linux's rule. */
export function darwinDiskModel({ vendor, product }: Pick<DarwinBlockDevice, "vendor" | "product">): string | undefined {
  if (!vendor || GENERIC_VENDORS.has(vendor.toUpperCase())) return product;
  if (!product) return vendor;
  return product.toLowerCase().startsWith(vendor.toLowerCase()) ? product : `${vendor} ${product}`;
}

export function darwinDiskKind(d: Pick<DarwinBlockDevice, "interconnect" | "ioClass" | "medium" | "removable">): DiskKind {
  const ioClass = d.ioClass ?? "";
  if (d.interconnect === "Secure Digital") return "sd";
  if (/(?:CD|DVD|BD)BlockStorageDevice/.test(ioClass)) return "optical";
  // Apple Silicon's internal SSD is NVMe over the SoC fabric; an Intel Mac's and
  // a Thunderbolt enclosure's are NVMe over PCIe. Both classes say so.
  if (/NVMe/i.test(ioClass)) return "nvme";
  // udisks2 calls these thumb drives; they are the removable-media ones on USB.
  if (d.interconnect === "USB" && d.removable) return "thumb";
  if (d.medium === "Solid State") return "ssd";
  if (d.medium === "Rotational") return "hdd";
  return "unknown";
}

/** The whole disk a device id lives on: a partition's owner, or for an APFS
 *  volume the owner of its container's store. `/` is a snapshot of a volume, so
 *  on a normal Mac that is snapshot → container → partition → disk. */
export function wholeDiskOf(id: string, layout: DiskutilLayout, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  for (const [disk, parts] of layout.partitions) {
    if (parts.some((p) => p.id === id)) return disk;
  }
  const container = layout.volumeContainer.get(id);
  if (container !== undefined) {
    for (const store of layout.containerStores.get(container) ?? []) {
      const disk = wholeDiskOf(store, layout, depth + 1);
      if (disk) return disk;
    }
    return undefined;
  }
  // A filesystem written straight onto a disk with no partition table.
  return layout.partitions.has(id) && !layout.containerStores.has(id) ? id : undefined;
}

export function readDarwinPartitions(diskId: string, layout: DiskutilLayout, mounts: readonly DarwinMount[]): PartitionInfo[] {
  return (layout.partitions.get(diskId) ?? []).map((part) => {
    const container = [...layout.containerStores].find(([, stores]) => stores.includes(part.id))?.[0];
    const devices = new Set(container === undefined ? [part.id] : volumesOf(container, layout));
    const mine = mounts
      .filter((m) => devices.has(m.id))
      .sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
    const filesystem = container !== undefined
      ? "apfs"
      : mine[0]?.filesystem ?? (part.content ? CONTENT_FILESYSTEMS[part.content] : undefined);
    return {
      id: part.id,
      devicePath: `/dev/${part.id}`,
      sizeBytes: part.sizeBytes,
      ...(filesystem ? { filesystem } : {}),
      mounts: mine.map((m) => ({ mountPoint: m.mountPoint, filesystem: m.filesystem })),
    };
  });
}

/**
 * The inventory's drives, in the tick's order. Without `layout` (diskutil
 * failed) partitions are left out rather than reported as none, and no drive is
 * called the system disk.
 */
export function buildDarwinDiskInventory(
  devices: readonly DarwinBlockDevice[],
  layout: DiskutilLayout | undefined,
  mounts: readonly DarwinMount[],
): DiskInfo[] {
  const root = mounts.find((m) => m.mountPoint === "/")?.id;
  const systemDisk = layout && root ? wholeDiskOf(root, layout) : undefined;
  return devices.map((d) => {
    const model = darwinDiskModel(d);
    return {
      id: d.id,
      ...(model ? { model } : {}),
      kind: darwinDiskKind(d),
      capacityBytes: d.capacityBytes,
      systemDisk: d.id === systemDisk,
      // A card leaving its reader, or a USB or Thunderbolt drive leaving the Mac.
      removable: d.removable || d.ejectable,
      ...(d.serial ? { serial: d.serial } : {}),
      ...(layout ? { partitions: readDarwinPartitions(d.id, layout, mounts) } : {}),
    };
  });
}

/** The three tools in parallel, then statfs on every mount — async, off the
 *  event loop, exactly as on Linux. */
export async function readDarwinDiskInventory(reads: DarwinToolReads, statfs?: StatfsReader): Promise<DiskInfo[]> {
  const [devices, layout, mounts] = await Promise.all([reads.blockDevices(), reads.diskutilList(), reads.mounts()]);
  const disks = buildDarwinDiskInventory(
    parseBlockDevices(devices?.value),
    layout ? parseDiskutilList(layout.value) : undefined,
    parseMountTable(mounts?.value ?? ""),
  );
  await attachPartitionUsage(disks, statfs);
  return disks;
}

function volumesOf(container: string, layout: DiskutilLayout): string[] {
  return [...layout.volumeContainer].filter(([, c]) => c === container).map(([volume]) => volume);
}

function dicts(v: PlistValue | undefined): PlistDict[] {
  return (plistArray(v) ?? []).map(plistDict).filter((d): d is PlistDict => d !== undefined);
}

function ids(v: PlistValue | undefined, key: string): string[] {
  return dicts(v).map((d) => plistString(d[key])).filter((s): s is string => !!s);
}
