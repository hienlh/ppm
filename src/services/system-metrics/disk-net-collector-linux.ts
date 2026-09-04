/**
 * Linux disk + net cumulative counters from `/proc`. No subprocess; the reader
 * is injectable so the parsers are fixture-tested without a real `/proc`.
 */
import { readFileSync } from "node:fs";
import type { CounterSample } from "./rate-delta.ts";

export interface DiskNetCounters {
  disk: CounterSample | null;
  net: CounterSample | null;
  warnings: string[];
}

export type FileReader = (path: string) => string | null;

const SECTOR_BYTES = 512;
/** Whole devices only — partitions, `loop*`, `dm-*` would double-count every byte. */
const WHOLE_DEVICE = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|mmcblk\d+|xvd[a-z]+)$/;

/** `/proc/diskstats`: field 6 = sectors read, field 10 = sectors written (1-based after major/minor/name). */
export function parseDiskstats(text: string): { inBytes: number; outBytes: number } | null {
  let read = 0;
  let written = 0;
  let matched = false;
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2] ?? "";
    if (!WHOLE_DEVICE.test(name)) continue;
    const r = Number(f[5]);
    const w = Number(f[9]);
    if (!Number.isFinite(r) || !Number.isFinite(w)) continue;
    matched = true;
    read += r;
    written += w;
  }
  return matched ? { inBytes: read * SECTOR_BYTES, outBytes: written * SECTOR_BYTES } : null;
}

/** `/proc/net/dev`: `iface: rx_bytes … tx_bytes …` with rx at col 0 and tx at col 8 after the colon. `lo` excluded. */
export function parseNetDev(text: string): { inBytes: number; outBytes: number } | null {
  let rx = 0;
  let tx = 0;
  let matched = false;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const iface = line.slice(0, colon).trim();
    if (!iface || iface === "lo") continue;
    const f = line.slice(colon + 1).trim().split(/\s+/);
    if (f.length < 9) continue;
    const r = Number(f[0]);
    const t = Number(f[8]);
    if (!Number.isFinite(r) || !Number.isFinite(t)) continue;
    matched = true;
    rx += r;
    tx += t;
  }
  return matched ? { inBytes: rx, outBytes: tx } : null;
}

export const defaultFileReader: FileReader = (path) => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
};

/** `/proc` carries no counter clock, so the wall clock is the only option here. */
export function collectLinuxDiskNet(read: FileReader = defaultFileReader, now: () => number = Date.now): DiskNetCounters {
  const warnings: string[] = [];
  const atSec = now() / 1000;

  const diskText = read("/proc/diskstats");
  const diskRaw = diskText ? parseDiskstats(diskText) : null;
  if (!diskRaw) warnings.push("Disk throughput unavailable: /proc/diskstats has no whole-device rows");

  const netText = read("/proc/net/dev");
  const netRaw = netText ? parseNetDev(netText) : null;
  if (!netRaw) warnings.push("Network throughput unavailable: /proc/net/dev unreadable");

  return {
    disk: diskRaw ? { ...diskRaw, atSec } : null,
    net: netRaw ? { ...netRaw, atSec } : null,
    warnings,
  };
}
