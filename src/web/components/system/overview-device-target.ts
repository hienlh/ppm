/**
 * Which Performance device an Overview card opens.
 *
 * Three of the five cards have a 1-to-1 target and need no logic: CPU is `cpu`,
 * Memory is `memory`, and each GPU card already knows its own GPU. The Disk and
 * Network cards are the awkward pair — they show **whole-machine** rates while
 * the Performance sidebar lists every drive and every interface separately (two
 * drives and seven interfaces on an ordinary desktop), so a card click has to
 * choose one.
 *
 * It chooses the busiest, because that is what the reader was looking at: you
 * click a Disk card that says "Write 191 MB/s" to find out which drive is doing
 * it. The cost, accepted deliberately: the destination is not fixed, so the same
 * card can open Disk 1 now and Disk 0 later. The alternative — always the first
 * device — is predictable and usually wrong, since `Disk 0` on this host is an
 * idle Toshiba while the loaded drive is `Disk 1`.
 *
 * Each metric matches the figure its own surface already shows, so the jump never
 * contradicts what was on screen: **active time** for a drive (what the sidebar
 * prints, and Mission Center's choice — a drive at 100% busy moving very little
 * still matters) and **raw throughput** for an interface (what the card prints;
 * normalising by link speed would rank a 100 Mbit NIC at 50% above a 10 Gbit one
 * carrying ten times the traffic).
 *
 * Pure, React-free, relative imports only. The keys are `DeviceEntry.key`
 * strings, so they are coupled to `performance/device-list.ts` by format — which
 * is why the test asserts the key against a real `buildDeviceList` rather than
 * against a literal. A key that matches no entry is not an error anywhere:
 * `resolveSelected` silently falls back to the first entry, so the jump would
 * quietly land on CPU.
 */
import type { SystemMetrics } from "../../../types/system-metrics";

/** Highest-scoring entry, or null when there is nothing to pick from. Ties go to
 *  the first, so a wholly idle machine is at least deterministic. */
function busiest<T>(items: readonly T[], score: (item: T) => number | null): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s === null) continue;
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  // Every device unmeasurable (every `available: false`, i.e. the very first
  // tick) still has to go somewhere, so fall back to the first one and let its
  // page render the em dashes honestly.
  return best ?? items[0] ?? null;
}

/** The drive with the most active time. Null when the host reports no drives. */
export function busiestDiskKey(system: SystemMetrics): string | null {
  const disk = busiest(system.disks ?? [], (d) => (d.available ? d.busyPercent : null));
  return disk ? `disk:${disk.id}` : null;
}

/** The interface carrying the most traffic. Null when the host reports none. */
export function busiestNicKey(system: SystemMetrics): string | null {
  const nic = busiest(system.nics ?? [], (n) => (n.available ? n.rxBps + n.txBps : null));
  return nic ? `nic:${nic.id}` : null;
}

/** The sidebar key for one GPU, matching `buildDeviceList`'s own fallback to the
 *  index for a device with no PCI address. */
export function gpuKey(id: string | undefined, index: number): string {
  return `gpu:${id ?? index}`;
}
