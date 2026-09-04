import { describe, test, expect } from "bun:test";
import {
  parseDiskstats,
  parseNetDev,
  collectLinuxDiskNet,
} from "../../../../src/services/system-metrics/disk-net-collector-linux.ts";

// Captured shape of /proc/diskstats: major minor name reads … sectors_read(6) … sectors_written(10) …
const DISKSTATS = [
  "   7       0 loop0 100 0 2000 10 0 0 0 0 0 10 10 0 0 0 0 0 0",
  " 259       0 nvme0n1 5000 100 800000 3000 2000 50 400000 9000 0 4000 12000 0 0 0 0 0 0",
  " 259       1 nvme0n1p1 4000 90 700000 2500 1500 40 300000 8000 0 3500 10500 0 0 0 0 0 0",
  "   8       0 sda 100 0 16000 50 20 0 8000 100 0 100 150 0 0 0 0 0 0",
  " 253       0 dm-0 1 0 8 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
].join("\n");

const NETDEV = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 5000000   10000    0    0    0     0          0         0  5000000   10000    0    0    0     0       0          0",
  "  eth0: 123456789  900000    0    0    0     0          0      1000  98765432  800000    0    0    0     0       0          0",
  "wlan0:  1000     10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0",
].join("\n");

describe("parseDiskstats", () => {
  test("sums whole devices only and converts sectors to bytes", () => {
    const r = parseDiskstats(DISKSTATS)!;
    // nvme0n1 + sda; the partition, loop and dm rows must not double-count.
    expect(r.inBytes).toBe((800000 + 16000) * 512);
    expect(r.outBytes).toBe((400000 + 8000) * 512);
  });

  test("returns null when no whole-device row exists", () => {
    expect(parseDiskstats("   7       0 loop0 1 0 8 0 0 0 0 0 0 0 0 0 0 0 0 0 0")).toBeNull();
    expect(parseDiskstats("")).toBeNull();
  });
});

describe("parseNetDev", () => {
  test("sums rx/tx across interfaces, excluding lo, tolerating a missing space before the colon", () => {
    const r = parseNetDev(NETDEV)!;
    expect(r.inBytes).toBe(123456789 + 1000);
    expect(r.outBytes).toBe(98765432 + 2000);
  });

  test("returns null on a header-only dump", () => {
    expect(parseNetDev(NETDEV.split("\n").slice(0, 2).join("\n"))).toBeNull();
  });
});

describe("collectLinuxDiskNet", () => {
  test("stamps both counters with the same wall clock and warns per missing source", () => {
    const files: Record<string, string> = { "/proc/diskstats": DISKSTATS };
    const r = collectLinuxDiskNet((p) => files[p] ?? null, () => 42_000);
    expect(r.disk?.atSec).toBe(42);
    expect(r.net).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("Network");
  });
});
