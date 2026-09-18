/**
 * Ordering for the Services table.
 *
 * Separate from `process-table-sort.ts` rather than sharing it, for two reasons
 * that are both about this page's data and not about tidiness. A service row's
 * figures are `UnitResources | undefined` — the WHOLE row can be unmeasured,
 * where a process row always has a CPU and a memory number — and `SortableFields`
 * types those two as required, so sharing it would mean passing 0 for "not
 * measured" and losing exactly the distinction the sort has to respect. And the
 * Services table sorts on `pid`, which is a systemd property rather than a
 * metric and is not in `SortKey` at all.
 *
 * The rule it does share, deliberately: **an unmeasured value sorts last in
 * either direction**. It is not a small value, it is the absence of one, and a
 * column of em dashes at the top of an ascending sort would read as "these units
 * use the least".
 *
 * Pure, React-free, relative imports only.
 */
import { compareServices } from "./service-rows";
import type { UnitResources } from "./service-resources";
import type { ServiceColumnKey } from "./service-columns";
import type { ServiceInfo } from "../../../../types/system-services";
import type { SortDir } from "../../../../types/system-metrics";

export type ServiceSortKey = ServiceColumnKey;

/** A unit paired with the roll-up over its cgroup for this tick. */
export interface ServiceListRow {
  service: ServiceInfo;
  resources?: UnitResources;
}

/** `undefined` only when NEITHER half is measured — the same rule the Drive cell
 *  formats by, so the column sorts on the number it is showing. */
function sumPair(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/** The comparable number behind a column, or `undefined` for "not measured".
 *  `name` is not here because it compares as text. */
export function sortValueOf(row: ServiceListRow, key: Exclude<ServiceSortKey, "name">): number | undefined {
  const r = row.resources;
  switch (key) {
    // A unit with no main process is not a unit with pid 0.
    case "pid": return row.service.mainPid ?? undefined;
    case "cpu": return r?.cpu;
    case "ram": return r?.ramMB;
    case "swap": return r?.swapMB;
    case "disk": return sumPair(r?.diskReadBps, r?.diskWriteBps);
    case "gpu": return r?.gpuPct;
    case "gpuMem": return r?.gpuMemMB;
  }
}

/**
 * `key === null` is the page's own default — failed first, then running, then
 * alphabetically — which is what the third click of a column header returns to.
 * That default is the reason the page is usually opened at all, so it has to
 * remain reachable rather than being replaced by whichever column was last used.
 *
 * Ties break on the unit name in every branch. Without it the list is re-sorted
 * from a fresh array on each 2 s tick, and the hundred-odd units that all read
 * 0% would swap places on every one of them.
 */
export function sortServiceRows(
  rows: readonly ServiceListRow[],
  key: ServiceSortKey | null,
  dir: SortDir,
): ServiceListRow[] {
  if (key === null) return [...rows].sort((a, b) => compareServices(a.service, b.service));

  if (key === "name") {
    return [...rows].sort((a, b) => {
      const cmp = a.service.unit.localeCompare(b.service.unit);
      return dir === "asc" ? cmp : -cmp;
    });
  }

  return [...rows].sort((a, b) => {
    const av = sortValueOf(a, key);
    const bv = sortValueOf(b, key);
    if (av === undefined && bv === undefined) return a.service.unit.localeCompare(b.service.unit);
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    if (av === bv) return a.service.unit.localeCompare(b.service.unit);
    return dir === "asc" ? av - bv : bv - av;
  });
}
