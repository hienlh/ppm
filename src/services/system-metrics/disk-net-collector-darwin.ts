/**
 * macOS whole-machine disk + net counters, for the Overview's Disk and Network
 * cards. They come out of the same `ioreg` and `netstat` reads the per-drive and
 * per-interface pages use (`darwin-tool-reads.ts`), so a tick spawns each tool
 * once and the card is the sum of the pages rather than a figure measured a few
 * milliseconds apart. On a failed read the counter is `null` (→ `available:false`
 * plus a warning), never 0.
 */
import type { DiskNetCounters } from "./disk-net-collector-linux.ts";
import { darwinToolReads, type DarwinToolReads } from "./darwin-tool-reads.ts";
import { parseBlockDevices, sumDiskCounters } from "./disk-devices-darwin.ts";
import { parseNetstatLinks, sumNetCounters } from "./net-devices-darwin.ts";

export async function collectDarwinDiskNet(reads: DarwinToolReads = darwinToolReads()): Promise<DiskNetCounters> {
  const warnings: string[] = [];
  const [devices, netstat] = await Promise.all([reads.blockDevices(), reads.netstat()]);

  const diskSum = devices ? sumDiskCounters(parseBlockDevices(devices.value)) : null;
  const disk = diskSum && devices ? { ...diskSum, atSec: devices.atSec } : null;
  if (!disk) warnings.push("Disk throughput unavailable: ioreg block storage statistics not readable");

  const netSum = netstat ? sumNetCounters(parseNetstatLinks(netstat.value)) : null;
  const net = netSum && netstat ? { ...netSum, atSec: netstat.atSec } : null;
  if (!net) warnings.push("Network throughput unavailable: netstat -ib not readable");

  return { disk, net, warnings };
}
