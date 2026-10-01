/**
 * Per-drive figures on macOS, from the IOKit registry. `ioreg` prints every block
 * storage device as a small tree — the device (what the drive says it is), its
 * `IOBlockStorageDriver` (which counts the I/O) and the whole-disk `IOMedia`
 * (which carries the BSD name, "disk0") — so one call answers for every drive.
 *
 * Mounted disk images are block storage devices too, and are skipped the way
 * Linux skips loop devices: reading a `.dmg` reads the file on the real drive,
 * so counting both would count every byte twice. So is a device with no media
 * under it — an empty card reader has nothing to measure.
 *
 * The counters are turned into the Linux sample shape so the arithmetic is the
 * same function on both platforms (`toDiskMetrics`, Mission Center's). The one
 * figure macOS cannot give is `io_ticks`, the time the device had any request in
 * flight, which is what Linux's "Active time" is. What IOKit keeps instead is the
 * time spent on each request, summed per request. Used in its place, busy % is an
 * ESTIMATE: exact while requests do not overlap, and reaching 100% early once they
 * do — an NVMe drive serving eight requests at once for a quarter of a second
 * reports two seconds of request time, which is why the result is capped.
 */
import type { DiskMetrics } from "../../types/system-metrics.ts";
import { toDiskMetrics, type DiskSample, type DiskSampleState } from "./disk-devices-linux.ts";
import {
  plistArray, plistBool, plistDict, plistNumber, plistString, type PlistDict, type PlistValue,
} from "./plist-xml.ts";

const SECTOR_BYTES = 512;
const NS_PER_MS = 1e6;

/** The driver's cumulative `Statistics`, since the device appeared. */
export interface DarwinDiskStats {
  readBytes: number;
  writeBytes: number;
  readOps: number;
  writeOps: number;
  /** Nanoseconds spent on requests, summed per request. */
  readTimeNs: number;
  writeTimeNs: number;
}

export interface DarwinBlockDevice {
  /** BSD name of the whole disk, "disk0" — the key `DiskMetrics.id` and
   *  `DiskInfo.id` use. */
  id: string;
  /** `Device Characteristics`, as the drive reports them. */
  vendor?: string;
  product?: string;
  serial?: string;
  /** "Solid State" or "Rotational"; absent on a card reader and most USB sticks. */
  medium?: string;
  /** `Protocol Characteristics`: "Apple Fabric", "PCI-Express", "USB",
   *  "Secure Digital", "SATA", … and "Internal" / "External". */
  interconnect?: string;
  location?: string;
  /** The device's IOKit class — "IOEmbeddedNVMeBlockDevice",
   *  "IODVDBlockStorageDevice" — which names what the other fields leave out. */
  ioClass?: string;
  capacityBytes: number;
  /** The media's own flags: a card or a stick can leave the reader (`removable`),
   *  a USB SSD can leave the Mac (`ejectable`). */
  removable: boolean;
  ejectable: boolean;
  stats: DarwinDiskStats;
}

/**
 * Every physical drive in `ioreg -a -r -l -d 3 -c IOBlockStorageDevice`, sorted
 * by BSD unit so "Disk 0" is disk0. A malformed entry is skipped, never thrown.
 */
export function parseBlockDevices(root: PlistValue | undefined): DarwinBlockDevice[] {
  const out: DarwinBlockDevice[] = [];
  for (const entry of plistArray(root) ?? []) {
    const device = plistDict(entry);
    if (!device) continue;
    const protocol = plistDict(device["Protocol Characteristics"]);
    const interconnect = text(protocol?.["Physical Interconnect"]);
    const location = text(protocol?.["Physical Interconnect Location"]);
    if (interconnect === "Virtual Interface" || location === "File") continue;

    for (const driver of children(device)) {
      const stats = plistDict(driver.Statistics);
      const media = children(driver).find((m) => plistBool(m.Whole) === true && text(m["BSD Name"]));
      if (!stats || !media) continue;
      const characteristics = plistDict(device["Device Characteristics"]);
      out.push({
        id: text(media["BSD Name"])!,
        ...optional("vendor", text(characteristics?.["Vendor Name"])),
        ...optional("product", text(characteristics?.["Product Name"])),
        ...optional("serial", text(characteristics?.["Serial Number"])),
        ...optional("medium", text(characteristics?.["Medium Type"])),
        ...optional("interconnect", interconnect),
        ...optional("location", location),
        ...optional("ioClass", text(device.IOObjectClass)),
        capacityBytes: plistNumber(media.Size) ?? 0,
        removable: plistBool(media.Removable) === true,
        ejectable: plistBool(media.Ejectable) === true,
        stats: {
          readBytes: counter(stats, "Bytes (Read)"),
          writeBytes: counter(stats, "Bytes (Write)"),
          readOps: counter(stats, "Operations (Read)"),
          writeOps: counter(stats, "Operations (Write)"),
          readTimeNs: counter(stats, "Total Time (Read)"),
          writeTimeNs: counter(stats, "Total Time (Write)"),
        },
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/**
 * The Linux sample shape, from IOKit's counters. Bytes become 512-byte "sectors"
 * only so `toDiskMetrics` can multiply them back — division by a power of two is
 * exact in binary floating point, so no byte is lost either way. There is no
 * discard or flush count on macOS; zero adds nothing to the sums.
 */
export function toDiskSample(stats: DarwinDiskStats, atSec: number): DiskSample {
  const readTicks = stats.readTimeNs / NS_PER_MS;
  const writeTicks = stats.writeTimeNs / NS_PER_MS;
  return {
    atSec,
    readIos: stats.readOps, readSectors: stats.readBytes / SECTOR_BYTES, readTicks,
    writeIos: stats.writeOps, writeSectors: stats.writeBytes / SECTOR_BYTES, writeTicks,
    // The estimate described at the top of this file.
    ioTicks: readTicks + writeTicks,
    discardIos: 0, discardTicks: 0, flushIos: 0, flushTicks: 0,
  };
}

export interface DarwinDiskCollection {
  disks: DiskMetrics[];
  next: DiskSampleState;
}

/** The IOKit class of an Apple Silicon Mac's built-in SSD. */
export const EMBEDDED_NVME_CLASS = "IOEmbeddedNVMeBlockDevice";

/**
 * One tick's per-drive figures, each drive against its own previous sample.
 *
 * `internalTempC` is the built-in SSD's NAND temperature. The sensor names no
 * disk, only that it is the internal flash, so it goes to the one drive that is
 * the embedded NVMe device; with none, or with more than one, no drive gets it.
 */
export function collectDarwinDiskDevices(
  devices: readonly DarwinBlockDevice[],
  atSec: number,
  prev: DiskSampleState,
  internalTempC?: number,
): DarwinDiskCollection {
  const embedded = devices.filter((d) => d.ioClass === EMBEDDED_NVME_CLASS);
  const tempOwner = internalTempC !== undefined && embedded.length === 1 ? embedded[0]!.id : undefined;
  const next: DiskSampleState = new Map();
  const disks = devices.map((device) => {
    const sample = toDiskSample(device.stats, atSec);
    next.set(device.id, sample);
    return toDiskMetrics(device.id, prev.get(device.id) ?? null, sample, device.id === tempOwner ? internalTempC : undefined);
  });
  return { disks, next };
}

/** The whole-machine Disk card: the same drives the per-drive pages list, so the
 *  card is their sum rather than a figure with disk images in it. */
export function sumDiskCounters(devices: readonly DarwinBlockDevice[]): { inBytes: number; outBytes: number } | null {
  if (devices.length === 0) return null;
  let inBytes = 0;
  let outBytes = 0;
  for (const { stats } of devices) {
    inBytes += stats.readBytes;
    outBytes += stats.writeBytes;
  }
  return { inBytes, outBytes };
}

function children(node: PlistDict): PlistDict[] {
  return (plistArray(node.IORegistryEntryChildren) ?? []).map(plistDict).filter((d): d is PlistDict => !!d);
}

/** A counter that is missing or not a number reads as 0: it only ever feeds a
 *  delta, and a device that stops reporting one looks idle rather than broken. */
function counter(stats: PlistDict, key: string): number {
  const n = plistNumber(stats[key]);
  return n !== undefined && n >= 0 ? n : 0;
}

/** SCSI and ATA fields are fixed-width and arrive padded; an empty one is absent. */
function text(v: PlistValue | undefined): string | undefined {
  const s = plistString(v)?.trim();
  return s ? s : undefined;
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
