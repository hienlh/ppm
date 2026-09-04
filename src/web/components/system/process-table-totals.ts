/** Footer totals accumulator, split out of `process-table-model.ts` to keep
 *  that file under the repo's 200-line guideline. Pure, no React/I/O. */

export interface Totals {
  cpu: number;
  ramMB: number;
  count: number;
  /** Sums over rows with a defined value; `undefined` when NO visible row measured
   *  that metric — mirrors the "undefined = host can't measure" rule on ProcessInfo. */
  diskReadBps?: number;
  diskWriteBps?: number;
  gpuMemMB?: number;
  netInBps?: number;
  netOutBps?: number;
}

export const EMPTY_TOTALS: Totals = { cpu: 0, ramMB: 0, count: 0 };

/** Adds an optional metric into a running total; stays `undefined` until at
 *  least one contributor has a defined value (mirrors the roll-up rule). */
function addOptional(sum: number | undefined, value: number | undefined): number | undefined {
  if (value === undefined) return sum;
  return (sum ?? 0) + value;
}

export function accumulateTotals(
  acc: Totals,
  item: {
    cpu: number;
    ramMB: number;
    diskReadBps?: number;
    diskWriteBps?: number;
    gpuMemMB?: number;
    netInBps?: number;
    netOutBps?: number;
  },
  countDelta: number,
): Totals {
  return {
    cpu: acc.cpu + item.cpu,
    ramMB: acc.ramMB + item.ramMB,
    count: acc.count + countDelta,
    diskReadBps: addOptional(acc.diskReadBps, item.diskReadBps),
    diskWriteBps: addOptional(acc.diskWriteBps, item.diskWriteBps),
    gpuMemMB: addOptional(acc.gpuMemMB, item.gpuMemMB),
    netInBps: addOptional(acc.netInBps, item.netInBps),
    netOutBps: addOptional(acc.netOutBps, item.netOutBps),
  };
}
