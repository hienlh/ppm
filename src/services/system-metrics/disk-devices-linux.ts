/**
 * Per-disk figures for the Performance page's drive entries, from
 * `/sys/block/<dev>/stat`. The arithmetic is Mission Center's
 * (`platform-linux/src/disks/stats.rs`): busy% is iostat's %util, response time
 * is weighted ticks over completed requests, and throughput is sectors x 512.
 *
 * Every device is sampled against its OWN previous sample, so a drive that
 * appears mid-session reports `available:false` for one tick instead of a spike
 * measured from zero.
 */
import type { DiskMetrics } from "../../types/system-metrics.ts";
import { readNumber, realLinuxFs, type LinuxFs } from "./linux-fs.ts";

export const SYS_BLOCK = "/sys/block";
const SECTOR_BYTES = 512;

/** Mission Center's list, matched on a 2-4 character prefix: virtual devices
 *  whose counters double-count the real drive underneath, or are not a drive. */
const IGNORED_PREFIXES = ["loop", "ram", "zram", "fd", "md", "dm", "zd"];

/** `/sys/block/<dev>/stat` field indices. The line has 17 fields since 5.5; the
 *  discard group (12-16) and flush group (17-18) are absent on older kernels,
 *  which reads as 0 here rather than as an error. */
const IDX = {
  readIos: 0, readSectors: 2, readTicks: 3,
  writeIos: 4, writeSectors: 6, writeTicks: 7,
  ioTicks: 9,
  discardIos: 11, discardTicks: 14,
  flushIos: 15, flushTicks: 16,
} as const;

export interface DiskSample {
  /** Wall clock in seconds — the sysfs stat line carries no timestamp. */
  atSec: number;
  readIos: number; readSectors: number; readTicks: number;
  writeIos: number; writeSectors: number; writeTicks: number;
  ioTicks: number;
  discardIos: number; discardTicks: number;
  flushIos: number; flushTicks: number;
}

/** Previous sample per device id. */
export type DiskSampleState = Map<string, DiskSample>;

export function isIgnoredDisk(id: string): boolean {
  return IGNORED_PREFIXES.some((p) => id.startsWith(p));
}

/** Whole devices udev would call disks: skips the virtual prefixes and anything
 *  reporting a zero size (an empty card reader, a detached loop device). */
export function listDiskDevices(fs: Pick<LinuxFs, "list" | "read"> = realLinuxFs): string[] {
  const names = fs.list(SYS_BLOCK);
  if (!names) return [];
  return names
    .filter((n) => !isIgnoredDisk(n))
    .filter((n) => (readNumber(fs, `${SYS_BLOCK}/${n}/size`) ?? 0) > 0)
    .sort();
}

export function parseDiskStat(text: string, atSec: number): DiskSample | null {
  const f = text.trim().split(/\s+/).map(Number);
  if (f.length < 11 || f.some((v) => !Number.isFinite(v))) return null;
  const at = (i: number) => f[i] ?? 0;
  return {
    atSec,
    readIos: at(IDX.readIos), readSectors: at(IDX.readSectors), readTicks: at(IDX.readTicks),
    writeIos: at(IDX.writeIos), writeSectors: at(IDX.writeSectors), writeTicks: at(IDX.writeTicks),
    ioTicks: at(IDX.ioTicks),
    discardIos: at(IDX.discardIos), discardTicks: at(IDX.discardTicks),
    flushIos: at(IDX.flushIos), flushTicks: at(IDX.flushTicks),
  };
}

/** NVMe exposes a composite sensor at `device/hwmon<N>/temp1_input`; a SATA drive
 *  exposes the same path only once `drivetemp` is loaded, which it usually is not
 *  — hence undefined rather than 0. Millidegrees, one decimal kept. */
export function readDiskTempC(id: string, fs: Pick<LinuxFs, "list" | "read"> = realLinuxFs): number | undefined {
  const dir = `${SYS_BLOCK}/${id}/device`;
  const hwmon = fs.list(dir)?.find((n) => n.startsWith("hwmon"));
  if (!hwmon) return undefined;
  const milli = readNumber(fs, `${dir}/${hwmon}/temp1_input`);
  return milli === undefined ? undefined : Math.round(milli / 100) / 10;
}

export interface DiskDeviceCollection {
  disks: DiskMetrics[];
  next: DiskSampleState;
}

/** One tick's worth of per-device figures. Devices absent from `prev` report
 *  `available:false` — totals are still real, they are absolutes. */
export function collectLinuxDiskDevices(
  prev: DiskSampleState,
  fs: Pick<LinuxFs, "list" | "read"> = realLinuxFs,
  now: () => number = Date.now,
): DiskDeviceCollection {
  const atSec = now() / 1000;
  const next: DiskSampleState = new Map();
  const disks: DiskMetrics[] = [];

  for (const id of listDiskDevices(fs)) {
    const text = fs.read(`${SYS_BLOCK}/${id}/stat`);
    const sample = text ? parseDiskStat(text, atSec) : null;
    if (!sample) continue;
    next.set(id, sample);
    disks.push(toDiskMetrics(id, prev.get(id) ?? null, sample, readDiskTempC(id, fs)));
  }
  return { disks, next };
}

export function toDiskMetrics(
  id: string,
  prev: DiskSample | null,
  next: DiskSample,
  tempC: number | undefined,
): DiskMetrics {
  const base: DiskMetrics = {
    id,
    available: false,
    busyPercent: 0,
    responseMs: 0,
    readBps: 0,
    writeBps: 0,
    readTotal: next.readSectors * SECTOR_BYTES,
    writeTotal: next.writeSectors * SECTOR_BYTES,
    ...(tempC === undefined ? {} : { tempC }),
  };

  const dt = prev ? next.atSec - prev.atSec : 0;
  // A device reset (hot-replug reusing the name) walks the counters backwards;
  // one unavailable tick is the honest answer, not a negative rate.
  if (!prev || !Number.isFinite(dt) || dt <= 0 || next.ioTicks < prev.ioTicks) return base;

  const ticks = delta(next.readTicks, prev.readTicks) + delta(next.writeTicks, prev.writeTicks)
    + delta(next.discardTicks, prev.discardTicks) + delta(next.flushTicks, prev.flushTicks);
  const ios = delta(next.readIos, prev.readIos) + delta(next.writeIos, prev.writeIos)
    + delta(next.discardIos, prev.discardIos) + delta(next.flushIos, prev.flushIos);

  return {
    ...base,
    available: true,
    busyPercent: round1(Math.min(100, delta(next.ioTicks, prev.ioTicks) / (dt * 10))),
    responseMs: ios > 0 ? round2(ticks / ios) : 0,
    readBps: Math.round(delta(next.readSectors, prev.readSectors) * SECTOR_BYTES / dt),
    writeBps: Math.round(delta(next.writeSectors, prev.writeSectors) * SECTOR_BYTES / dt),
  };
}

/** Saturating, as Mission Center's `saturating_sub`: these counters only ever
 *  grow, so a negative delta is a reset and contributes nothing. */
function delta(next: number, prev: number): number {
  return next > prev ? next - prev : 0;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
