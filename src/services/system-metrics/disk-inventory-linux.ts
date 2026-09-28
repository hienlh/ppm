/**
 * Static facts about each whole disk: model, kind, capacity, serial, and which
 * one carries the root filesystem. Read once per inventory request, not per tick.
 *
 * Mission Center gets all of this from udisks2 over D-Bus and SKIPS any drive
 * udisks2 has no object for, which on a headless or container host is every
 * drive. PPM reads sysfs plus udev's own database instead, so the list is the
 * same one the kernel has and needs neither a system bus nor root.
 */
import type { DiskInfo, DiskKind } from "../../types/system-hardware.ts";
import { readAttr, readNumber, realLinuxFs, type LinuxFs } from "./linux-fs.ts";
import { readUdevProperties, udevValue } from "./udev-db.ts";
import { listDiskDevices, SYS_BLOCK } from "./disk-devices-linux.ts";
import { parseMountInfo, readPartitions } from "./partitions-linux.ts";

const SECTOR_BYTES = 512;
/** How far to follow `slaves` links from the root filesystem's device down to a
 *  real drive (partition -> LUKS -> LVM -> RAID is already four). */
const MAX_SLAVE_DEPTH = 8;

/** The kernel fills SCSI's vendor field with the transport name for a SATA drive,
 *  so "ATA" is never a manufacturer. Mission Center prints it; PPM drops it. */
const GENERIC_VENDORS = new Set(["ATA", "SATA", "NVME", "USB", "SCSI"]);

export function readDiskInventory(fs: LinuxFs = realLinuxFs): DiskInfo[] {
  const systemDisk = findSystemDisk(fs);
  // Parsed once for the whole inventory rather than per disk: mountinfo is one
  // file describing every mount on the host, and re-reading it per drive is the
  // same work times however many drives there are.
  const mounts = parseMountInfo(fs.read("/proc/self/mountinfo") ?? "");
  return listDiskDevices(fs).map((id) => readDiskInfo(id, fs, systemDisk === id, mounts));
}

export function readDiskInfo(
  id: string,
  fs: LinuxFs,
  systemDisk: boolean,
  mounts = parseMountInfo(fs.read("/proc/self/mountinfo") ?? ""),
): DiskInfo {
  const udev = readUdevProperties(blockDeviceKey(id, fs), fs.read);
  const sectors = readNumber(fs, `${SYS_BLOCK}/${id}/size`) ?? 0;
  const rpm = Number(udevValue(udev, "ID_ATA_ROTATION_RATE_RPM"));

  return {
    id,
    ...optional("model", diskModel(id, fs, udev)),
    kind: diskKind(id, fs, udev),
    capacityBytes: sectors * SECTOR_BYTES,
    systemDisk,
    removable: readAttr(fs, `${SYS_BLOCK}/${id}/removable`) === "1",
    ...optional("serial", readAttr(fs, `${SYS_BLOCK}/${id}/device/serial`) ?? udevValue(udev, "ID_SERIAL_SHORT")),
    ...optional("wwn", diskWwn(id, fs, udev)),
    ...(Number.isFinite(rpm) && rpm > 0 ? { rotationRpm: rpm } : {}),
    partitions: readPartitions(id, fs, mounts),
  };
}

/** udev keys a block device by `b<major>:<minor>`, which sysfs reports in `dev`. */
export function blockDeviceKey(id: string, fs: Pick<LinuxFs, "read">): string {
  return `b${readAttr(fs, `${SYS_BLOCK}/${id}/dev`) ?? ""}`;
}

/** "vendor model", with the vendor dropped when it is generic or already the
 *  start of the model — Mission Center's rule plus the ATA case. */
export function diskModel(id: string, fs: Pick<LinuxFs, "read">, udev: ReadonlyMap<string, string>): string | undefined {
  const model = readAttr(fs, `${SYS_BLOCK}/${id}/device/model`) ?? udevValue(udev, "ID_MODEL")?.replace(/_/g, " ");
  const vendor = readAttr(fs, `${SYS_BLOCK}/${id}/device/vendor`);
  if (!vendor || GENERIC_VENDORS.has(vendor.toUpperCase())) return model;
  if (!model) return vendor;
  return model.startsWith(vendor) ? model : `${vendor} ${model}`;
}

export function diskKind(id: string, fs: Pick<LinuxFs, "read" | "list">, udev: ReadonlyMap<string, string>): DiskKind {
  if (id.startsWith("nvme")) return "nvme";
  if (id.startsWith("mmcblk")) return mmcKind(id, fs);
  if (id.startsWith("sr")) return "optical";
  const removable = readAttr(fs, `${SYS_BLOCK}/${id}/removable`) === "1";
  // udisks2 answers MediaCompatibility::Thumb for these; the same drives are the
  // removable ones on the USB bus, which udev already knows.
  if (removable && udevValue(udev, "ID_BUS") === "usb") return "thumb";
  const rotational = readAttr(fs, `${SYS_BLOCK}/${id}/queue/rotational`);
  if (rotational === "0") return "ssd";
  if (rotational === "1") return "hdd";
  return "unknown";
}

/** The mmc host's `type` attribute is "SD" or "MMC". */
function mmcKind(id: string, fs: Pick<LinuxFs, "read" | "list">): DiskKind {
  const index = id.slice("mmcblk".length);
  const host = `/sys/class/mmc_host/mmc${index}`;
  for (const entry of fs.list(host) ?? []) {
    if (!entry.startsWith(`mmc${index}`)) continue;
    const type = readAttr(fs, `${host}/${entry}/type`);
    if (type === "SD") return "sd";
    if (type === "MMC") return "emmc";
  }
  return "unknown";
}

/** NVMe writes `wwid` on the namespace, SATA on the device; udev's `ID_WWN` is
 *  cleaner than either and is preferred when present. A T10 identifier is built
 *  by concatenating fixed-width ATA fields, so it arrives padded — the runs are
 *  collapsed, since the value is shown to a person, not compared byte for byte. */
function diskWwn(id: string, fs: Pick<LinuxFs, "read">, udev: ReadonlyMap<string, string>): string | undefined {
  const raw = udevValue(udev, "ID_WWN")
    ?? readAttr(fs, `${SYS_BLOCK}/${id}/wwid`)
    ?? readAttr(fs, `${SYS_BLOCK}/${id}/device/wwid`);
  return raw?.replace(/\s+/g, " ");
}

/** The drive behind `/`. mountinfo names the SOURCE path (`/dev/nvme0n1p2`), not
 *  a disk, so it is resolved through sysfs: a partition's parent directory is its
 *  disk, and a mapper device (LUKS, LVM, RAID) is followed through `slaves`. */
export function findSystemDisk(fs: LinuxFs): string | undefined {
  const source = rootMountSource(fs.read("/proc/self/mountinfo") ?? "");
  if (!source) return undefined;
  const node = fs.realpath(source) ?? source;
  return wholeDiskOf(basename(node), fs, 0);
}

/** The `/` line's source device, or undefined when `/` is not a block mount. */
export function rootMountSource(mountinfo: string): string | undefined {
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    if (fields[4] !== "/") continue;
    const sep = fields.indexOf("-", 6);
    const source = sep >= 0 ? fields[sep + 2] : undefined;
    if (source?.startsWith("/dev/")) return source;
  }
  return undefined;
}

function wholeDiskOf(name: string, fs: LinuxFs, depth: number): string | undefined {
  if (!name || depth > MAX_SLAVE_DEPTH) return undefined;
  const real = fs.realpath(`/sys/class/block/${name}`);
  if (!real) return undefined;
  if (fs.exists(`${real}/partition`)) return wholeDiskOf(basename(dirname(real)), fs, depth + 1);
  for (const slave of fs.list(`${real}/slaves`) ?? []) {
    const disk = wholeDiskOf(slave, fs, depth + 1);
    if (disk) return disk;
  }
  return fs.exists(`${SYS_BLOCK}/${name}`) ? name : undefined;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string) => p.slice(0, p.lastIndexOf("/"));

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
