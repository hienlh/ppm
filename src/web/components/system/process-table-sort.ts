/** Sort comparator for the process table, split out of `process-table-model.ts`
 *  to keep that file under the repo's 200-line guideline once Disk/GPU/Net sort
 *  keys were added. No React, no I/O — pure so it's directly unit-testable. */
import type { SortDir, SortKey } from "../../../types/system-metrics";

/** Fields the comparator can read from either a `ProcessInfo` or a `ProcessGroup`
 *  roll-up — both carry the same six optional metric names per the contract.
 *  Optional metrics stay optional here: the "undefined sorts last, regardless of
 *  direction" rule below depends on being able to tell "unmeasured" from "0". */
export interface SortableFields {
  cpu: number;
  ramMB: number;
  name: string;
  diskReadBps?: number;
  diskWriteBps?: number;
  gpuPct?: number;
  gpuMemMB?: number;
  netInBps?: number;
  netOutBps?: number;
}

/** Maps a `ProcessInfo` or `ProcessGroup` into `SortableFields` — only `name`
 *  differs between the two shapes (process `name` vs. group `label`), so one
 *  function covers both sort inputs. */
export function sortFields(m: {
  cpu: number;
  ramMB: number;
  diskReadBps?: number;
  diskWriteBps?: number;
  gpuPct?: number;
  gpuMemMB?: number;
  netInBps?: number;
  netOutBps?: number;
}, name: string): SortableFields {
  return {
    cpu: m.cpu,
    ramMB: m.ramMB,
    name,
    diskReadBps: m.diskReadBps,
    diskWriteBps: m.diskWriteBps,
    gpuPct: m.gpuPct,
    gpuMemMB: m.gpuMemMB,
    netInBps: m.netInBps,
    netOutBps: m.netOutBps,
  };
}

/** `undefined` when neither side of the pair is measured — matches the
 *  ProcessInfo/ProcessGroup contract ("undefined when NO member has a value"). */
function sumPair(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function optionalValueFor(key: "disk" | "gpu" | "gpuMem" | "net", f: SortableFields): number | undefined {
  if (key === "disk") return sumPair(f.diskReadBps, f.diskWriteBps);
  if (key === "net") return sumPair(f.netInBps, f.netOutBps);
  if (key === "gpu") return f.gpuPct;
  return f.gpuMemMB;
}

function isOptionalSortKey(key: SortKey): key is "disk" | "gpu" | "gpuMem" | "net" {
  return key === "disk" || key === "gpu" || key === "gpuMem" || key === "net";
}

export function sortByKey<T>(items: T[], key: SortKey, dir: SortDir, get: (item: T) => SortableFields): T[] {
  if (!key) return items;
  return [...items].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (key === "name") {
      const cmp = av.name.localeCompare(bv.name);
      return dir === "asc" ? cmp : -cmp;
    }
    if (key === "cpu") return dir === "asc" ? av.cpu - bv.cpu : bv.cpu - av.cpu;
    if (key === "ram") return dir === "asc" ? av.ramMB - bv.ramMB : bv.ramMB - av.ramMB;

    // disk/gpu/gpuMem/net: optional metrics. Undefined always sorts last, in
    // EITHER direction — it means "unmeasurable", not "smallest value".
    if (isOptionalSortKey(key)) {
      const aVal = optionalValueFor(key, av);
      const bVal = optionalValueFor(key, bv);
      if (aVal === undefined && bVal === undefined) return 0;
      if (aVal === undefined) return 1;
      if (bVal === undefined) return -1;
      return dir === "asc" ? aVal - bVal : bVal - aVal;
    }
    return 0;
  });
}
