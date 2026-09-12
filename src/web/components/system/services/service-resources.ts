/**
 * Live figures per unit for the Services page — Mission Center's PID, CPU,
 * Memory, Swap, Drive, GPU and GPU Memory columns.
 *
 * The roll-up is done HERE, from the metrics stream's process rows, rather than
 * server-side in the Services route. The route is two `systemctl` spawns on a 3 s
 * poll with no counter state of its own, so computing CPU% there would mean a
 * second set of deltas over a second interval — and the same process would then
 * report two different CPU figures on two pages of the same window. Every figure
 * below is the one the Processes tab is already showing, summed.
 *
 * Pure and React-free; relative imports only.
 */
import type { ProcessInfo } from "../../../../types/system-metrics";
import type { ServiceInfo } from "../../../../types/system-services";

export interface UnitResources {
  /** Processes in the unit's cgroup, which is not the same as its `MainPID`:
   *  a unit with forked workers has one main pid and many processes. */
  count: number;
  cpu: number;
  ramMB: number;
  /** Optional exactly as on `ProcessInfo`: the sum over members that HAVE a
   *  value, `undefined` when none does — so an unmeasurable column stays an em
   *  dash instead of collapsing to a confident 0. */
  swapMB?: number;
  diskReadBps?: number;
  diskWriteBps?: number;
  gpuPct?: number;
  gpuMemMB?: number;
}

function addOptional(sum: number | undefined, value: number | undefined): number | undefined {
  if (value === undefined) return sum;
  return (sum ?? 0) + value;
}

/** `"<scope>:<unit>"` → summed figures. Rows with no `unitKey` — kernel threads,
 *  anything outside a unit — are simply not in any bucket. */
export function rollUpByUnit(processes: readonly ProcessInfo[]): Map<string, UnitResources> {
  const byUnit = new Map<string, UnitResources>();
  for (const p of processes) {
    if (!p.unitKey) continue;
    const row = byUnit.get(p.unitKey) ?? { count: 0, cpu: 0, ramMB: 0 };
    row.count += 1;
    row.cpu += p.cpu;
    row.ramMB += p.ramMB;
    row.swapMB = addOptional(row.swapMB, p.swapMB);
    row.diskReadBps = addOptional(row.diskReadBps, p.diskReadBps);
    row.diskWriteBps = addOptional(row.diskWriteBps, p.diskWriteBps);
    row.gpuPct = addOptional(row.gpuPct, p.gpuPct);
    row.gpuMemMB = addOptional(row.gpuMemMB, p.gpuMemMB);
    byUnit.set(p.unitKey, row);
  }
  // A GPU engine can only be busy for the interval that passed, however many of
  // a unit's processes were queueing work on it.
  for (const row of byUnit.values()) {
    row.cpu = Math.round(row.cpu * 10) / 10;
    row.ramMB = Math.round(row.ramMB * 10) / 10;
    if (row.gpuPct !== undefined) row.gpuPct = Math.min(100, Math.round(row.gpuPct * 10) / 10);
  }
  return byUnit;
}

export function unitKeyOf(service: ServiceInfo): string {
  return `${service.scope}:${service.unit}`;
}

/** What a unit with no processes gets: zeros, not dashes. Owning nothing really
 *  is using nothing, which is a reading — the em dash is reserved for a figure
 *  this host cannot measure at all. */
export const IDLE_UNIT: UnitResources = Object.freeze({
  count: 0, cpu: 0, ramMB: 0, swapMB: 0, diskReadBps: 0, diskWriteBps: 0, gpuPct: 0, gpuMemMB: 0,
});

/** Unit types that can hold processes at all. Everything else on this page —
 *  `.socket`, `.mount` — owns nothing by construction: a socket's processes live
 *  in the *service* it activates, and the socket itself has no `MainPID` and
 *  `TasksCurrent=0` even while systemd calls it `running`. */
const PROCESS_OWNING_SUFFIXES = [".service", ".scope"] as const;

/**
 * `ActiveState` cannot decide whether a unit ought to have processes, and using
 * it puts an em dash on 97 of this host's 222 rows: systemd reports a mount as
 * `active (mounted)`, a socket as `active (listening)` and a finished oneshot as
 * `active (exited)`, and every one of those owns nothing by construction. Those
 * are real zeros.
 *
 * `SubState` is most of the discriminator — only `running` asserts there are live
 * processes — but not all of it, because a LISTENING socket is also reported as
 * `running`: `systemctl show -p SubState docker.socket` answers `running` beside
 * an empty `MainPID` and `TasksCurrent=0`. That accounted for 14 of the 15 rows
 * still dashed after the `SubState` fix, so the unit's own type has to agree.
 */
export function resourcesFor(
  service: ServiceInfo,
  byUnit: ReadonlyMap<string, UnitResources> | null,
): UnitResources | undefined {
  if (!byUnit) return undefined;
  const found = byUnit.get(unitKeyOf(service));
  if (found) return found;
  const couldHaveProcesses = service.subState === "running"
    && PROCESS_OWNING_SUFFIXES.some((suffix) => service.unit.endsWith(suffix));
  return couldHaveProcesses ? undefined : IDLE_UNIT;
}
