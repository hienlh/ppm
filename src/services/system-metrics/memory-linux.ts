/**
 * Mission Center's memory page: the composition bar and the figures under it,
 * all from `/proc/meminfo`, plus the populated slots from the SMBIOS table udev
 * already decoded into its database (the raw table needs root; this does not).
 */
import type { MemoryMetrics } from "../../types/system-metrics.ts";
import type { MemoryDeviceInfo, MemoryInfo } from "../../types/system-hardware.ts";
import { realLinuxFs, type LinuxFs } from "./linux-fs.ts";
import { readUdevProperties, udevValue } from "./udev-db.ts";

/** udev's own name for the SMBIOS record. */
export const DMI_UDEV_DEVICE = "+dmi:id";
const MB = 1024 * 1024;

/** Every `Key: N kB` line as BYTES. Values without a unit (the HugePages counts)
 *  are kept verbatim, which is what they mean. */
export function parseMeminfo(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const rest = line.slice(sep + 1).trim();
    const [rawValue, unit] = rest.split(/\s+/);
    const n = Number(rawValue);
    if (!Number.isFinite(n)) continue;
    out.set(line.slice(0, sep), unit === "kB" ? n * 1024 : n);
  }
  return out;
}

/**
 * Adds the composition and the swap/commit figures to the cross-platform base.
 *
 * The four parts add up to the total EXACTLY and "in use" is exactly the headline
 * `usedMB` (total - MemAvailable), so the bar and the figure beside it can never
 * disagree. Standby is the rest of what the kernel would hand back on demand
 * (MemAvailable - MemFree), and modified is carved out of it rather than added —
 * a dirty page is also a cached page, so adding the two would overflow the bar.
 */
export function enrichMemory(
  base: MemoryMetrics,
  text: string | null,
  zram: ZramTotals | undefined = undefined,
): MemoryMetrics {
  if (!text) return base;
  const m = parseMeminfo(text);
  const total = m.get("MemTotal");
  if (total === undefined || total <= 0) return base;

  const get = (k: string) => m.get(k) ?? 0;
  const free = clamp(get("MemFree"), 0, total);
  const available = clamp(m.get("MemAvailable") ?? free, free, total);
  const reclaimable = available - free;
  const modified = clamp(get("Dirty") + get("Writeback"), 0, reclaimable);
  const swapTotal = get("SwapTotal");

  return {
    ...base,
    inUseBytes: total - available,
    modifiedBytes: modified,
    standbyBytes: reclaimable - modified,
    freeBytes: free,
    cachedMB: round1(get("Cached") / MB),
    committedMB: round1(get("Committed_AS") / MB),
    commitLimitMB: round1(get("CommitLimit") / MB),
    swapTotalMB: round1(swapTotal / MB),
    swapUsedMB: round1(Math.max(swapTotal - get("SwapFree"), 0) / MB),
    ...(zram
      ? {
          zramCompressedMB: round1(zram.compressedBytes / MB),
          zramSavingsMB: round1(zram.savingsBytes / MB),
        }
      : {}),
  };
}

export interface ZramTotals {
  compressedBytes: number;
  savingsBytes: number;
}

/**
 * `/sys/block/zram<N>/mm_stat`, summed over every device — a host can have one
 * per CPU. Undefined when there is no zram at all, which is a different answer
 * from a zram holding nothing: the Memory page hides the rows in the first case
 * and shows zeroes in the second.
 *
 * Field order (Documentation/admin-guide/blockdev/zram.rst): orig_data_size,
 * compr_data_size, mem_used_total, mem_limit, mem_used_max, same_pages,
 * pages_compacted, huge_pages. Savings is orig minus compr, which is what
 * Mission Center shows — NOT orig minus mem_used_total, which also subtracts
 * zram's own allocator overhead and reads several percent low.
 */
export function readZramTotals(fs: LinuxFs = realLinuxFs): ZramTotals | undefined {
  const devices = (fs.list("/sys/block") ?? []).filter((n) => /^zram\d+$/.test(n));
  if (devices.length === 0) return undefined;
  let compressedBytes = 0;
  let savingsBytes = 0;
  let any = false;
  for (const dev of devices) {
    const stat = fs.read(`/sys/block/${dev}/mm_stat`)?.trim().split(/\s+/);
    if (!stat || stat.length < 2) continue;
    const orig = Number(stat[0]);
    const compr = Number(stat[1]);
    if (!Number.isFinite(orig) || !Number.isFinite(compr)) continue;
    any = true;
    compressedBytes += compr;
    savingsBytes += Math.max(0, orig - compr);
  }
  return any ? { compressedBytes, savingsBytes } : undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The populated slots, in board order. `MEMORY_DEVICE_<n>_*` is udev's decode of
 *  SMBIOS type 17; an empty slot has no `SIZE`, so it simply does not appear. */
export function readMemoryInfo(fs: Pick<LinuxFs, "read"> = realLinuxFs): MemoryInfo {
  const props = readUdevProperties(DMI_UDEV_DEVICE, fs.read);
  const devices: MemoryDeviceInfo[] = [];

  for (let i = 0; ; i++) {
    const prefix = `MEMORY_DEVICE_${i}_`;
    const locator = udevValue(props, `${prefix}LOCATOR`);
    const size = Number(udevValue(props, `${prefix}SIZE`));
    // udev numbers the slots contiguously, so the first gap is the end of the list.
    if (!locator && !Number.isFinite(size)) break;
    if (i > 64) break;
    if (!locator || !Number.isFinite(size) || size <= 0) continue;
    devices.push({
      locator,
      sizeBytes: size,
      ...defined("bankLocator", udevValue(props, `${prefix}BANK_LOCATOR`)),
      ...defined("formFactor", udevValue(props, `${prefix}FORM_FACTOR`)),
      ...defined("ramType", udevValue(props, `${prefix}TYPE`)),
      ...defined("speedMts", positive(udevValue(props, `${prefix}SPEED_MTS`))),
      ...defined("manufacturer", udevValue(props, `${prefix}MANUFACTURER`)),
      ...defined("rank", positive(udevValue(props, `${prefix}RANK`))),
    });
  }

  return {
    devices,
    ...defined("maxCapacityBytes", positive(udevValue(props, "MEMORY_ARRAY_MAX_CAPACITY"))),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function positive(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
