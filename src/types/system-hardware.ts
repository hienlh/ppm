/** Static hardware facts for the Performance page — everything that does not change
 *  tick to tick, served once by GET /api/system/hardware instead of riding every 2 s
 *  snapshot over a tunnel. The client refetches when a snapshot names a device id it
 *  does not know (a USB disk plugged in, an interface created). Types + constants
 *  only. Import RELATIVELY — the "@" alias points at src/web. */
import type { GpuInfo, MetricsPlatform } from "./system-metrics.ts";

export type DiskKind = "hdd" | "ssd" | "nvme" | "emmc" | "sd" | "optical" | "thumb" | "unknown";

/** One place a partition is mounted. A partition can have several: a btrfs
 *  subvolume layout mounts the same device at `/`, `/home` and `/var/log`. */
export interface PartitionMount {
  mountPoint: string;
  filesystem: string;
  /** From `statfs` on the mount, not from the partition's size — metadata,
   *  root-reserved blocks and a shared subvolume pool all make the two differ.
   *  Both absent when statfs refused; a filesystem we could not read is not an
   *  empty one. */
  usedBytes?: number;
  totalBytes?: number;
}

export interface PartitionInfo {
  /** Kernel name, e.g. "sda1". */
  id: string;
  devicePath: string;
  /** What the partition table says, which is the number that never changes. */
  sizeBytes: number;
  /** udev's `ID_FS_TYPE`, so it is known even for a partition nothing mounted. */
  filesystem?: string;
  /** Empty for a partition that is not mounted anywhere. */
  mounts: PartitionMount[];
}

export interface DiskInfo {
  /** /sys/block name — the key `DiskMetrics.id` uses. */
  id: string;
  /** Vendor + model as the drive reports them; absent when it reports neither. */
  model?: string;
  kind: DiskKind;
  capacityBytes: number;
  /** Holds the root filesystem (through partitions, LUKS or LVM). */
  systemDisk: boolean;
  removable: boolean;
  serial?: string;
  wwn?: string;
  rotationRpm?: number;
  /** Absent on a platform with no partition support yet; empty on a disk with no
   *  partition table (a whole-device filesystem, an unformatted drive). */
  partitions?: PartitionInfo[];
}

/** Mission Center's interface kinds. It classifies by name prefix because its
 *  NetworkManager type read always fails; PPM uses sysfs first and the same
 *  prefixes only as the fallback. */
export type NicKind =
  | "wired" | "wireless" | "bluetooth" | "bridge" | "docker" | "infiniband"
  | "multipass" | "virtual" | "vpn" | "other";

export interface NicInfo {
  /** Interface name — the key `NicMetrics.id` uses. */
  id: string;
  kind: NicKind;
  /** Adapter name from the PCI/USB database ("RTL8125 2.5GbE Controller"). */
  deviceName?: string;
  driver?: string;
  /** Hardware address, absent for interfaces without one (tun, wireguard). */
  mac?: string;
  ipv4: string[];
  ipv6: string[];
}

/** Static CPU facts — Mission Center's CPU page header and its bottom grid. */
export interface CpuInfo {
  /** Marketing name, e.g. "12th Gen Intel(R) Core(TM) i9-12900K". */
  name: string;
  /** Populated sockets. */
  sockets: number;
  /** Physical cores across all sockets, and hardware threads. On a hybrid part
   *  (Intel P+E) the physical count is what the kernel reports per socket. */
  physicalCores: number;
  logicalCores: number;
  /** Nominal clock and the highest the driver will ask for, MHz. */
  baseMHz?: number;
  maxMHz?: number;
  /** "Intel VT-x" / "AMD-V", absent when the flag is missing (or hidden in a VM). */
  virtualization?: string;
  /** True when this kernel is itself running virtualised. */
  isVirtualMachine: boolean;
  /** Summed over DISTINCT caches, bytes. L1 combines data and instruction, as
   *  Mission Center does. Absent when sysfs exposes no cache topology. */
  l1CacheBytes?: number;
  l2CacheBytes?: number;
  l3CacheBytes?: number;
  /** cpufreq's driver, governor and energy-performance preference. */
  freqDriver?: string;
  freqGovernor?: string;
  powerPreference?: string;
}

/** One populated memory slot, from the SMBIOS table udev already decoded. */
export interface MemoryDeviceInfo {
  /** Slot name as the board labels it, e.g. "DDR4-A1". */
  locator: string;
  bankLocator?: string;
  sizeBytes: number;
  /** "DIMM", "SODIMM", … */
  formFactor?: string;
  /** "DDR4", "DDR5", … */
  ramType?: string;
  /** Configured transfer rate, MT/s. */
  speedMts?: number;
  manufacturer?: string;
  rank?: number;
}

export interface MemoryInfo {
  /** Populated slots. Empty when the firmware table is unreadable — the UI then
   *  shows the totals only, as Mission Center does inside a VM. */
  devices: MemoryDeviceInfo[];
  /** Slots the board has in total, when the firmware says. */
  slotsTotal?: number;
  /** Largest configuration the board accepts, bytes. */
  maxCapacityBytes?: number;
}

export interface HardwareInventory {
  platform: MetricsPlatform;
  /** Epoch ms the inventory was read. */
  ts: number;
  disks: DiskInfo[];
  nics: NicInfo[];
  gpus: GpuInfo[];
  /** Absent where the host exposes no CPU topology (never on Linux). */
  cpu?: CpuInfo;
  memory?: MemoryInfo;
}
