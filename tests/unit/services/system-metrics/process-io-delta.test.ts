import { describe, test, expect } from "bun:test";
import {
  computeProcIoRates,
  type ProcIoDeltaState,
} from "../../../../src/services/system-metrics/process-io-delta.ts";

const KEY = "50:5";

describe("computeProcIoRates", () => {
  test("first tick is 0 for every reported counter — a cumulative total is not a rate", () => {
    const { ratesByKey, next } = computeProcIoRates(null, [{ key: KEY, diskReadBytes: 10_000_000, diskWriteBytes: 5 }], 1000);
    expect(ratesByKey.get(KEY)).toEqual({ diskReadBps: 0, diskWriteBps: 0, netInBps: undefined, netOutBps: undefined });
    expect(next.at).toBe(1000);
  });

  test("bytes/second over the wall interval, rounded", () => {
    const t1 = computeProcIoRates(null, [{ key: KEY, diskReadBytes: 1_000, diskWriteBytes: 0 }], 1000);
    const t2 = computeProcIoRates(t1.next, [{ key: KEY, diskReadBytes: 5_000, diskWriteBytes: 300 }], 3000);
    // 4000 B over 2 s, 300 B over 2 s.
    expect(t2.ratesByKey.get(KEY)).toMatchObject({ diskReadBps: 2000, diskWriteBps: 150 });
  });

  test("a counter the OS did not report stays undefined, never 0", () => {
    const t1 = computeProcIoRates(null, [{ key: KEY, diskReadBytes: 1 }], 1000);
    const t2 = computeProcIoRates(t1.next, [{ key: KEY }], 3000);
    const r = t2.ratesByKey.get(KEY)!;
    expect(r.diskReadBps).toBeUndefined();
    expect(r.diskWriteBps).toBeUndefined();
    // undefined must not survive into the JSON frame as null.
    expect(JSON.stringify(r)).toBe("{}");
  });

  test("a counter going backwards (reset, or a pid whose key was reused) reads 0, then recovers", () => {
    const t1 = computeProcIoRates(null, [{ key: KEY, diskReadBytes: 9_000 }], 1000);
    const t2 = computeProcIoRates(t1.next, [{ key: KEY, diskReadBytes: 100 }], 3000);
    expect(t2.ratesByKey.get(KEY)!.diskReadBps).toBe(0);
    const t3 = computeProcIoRates(t2.next, [{ key: KEY, diskReadBytes: 2_100 }], 5000);
    expect(t3.ratesByKey.get(KEY)!.diskReadBps).toBe(1000);
  });

  test("a non-advancing clock cannot divide by zero", () => {
    const t1 = computeProcIoRates(null, [{ key: KEY, diskReadBytes: 1 }], 1000);
    const same = computeProcIoRates(t1.next, [{ key: KEY, diskReadBytes: 999_999 }], 1000);
    expect(same.ratesByKey.get(KEY)!.diskReadBps).toBe(0);
  });

  test("an absurd delta is treated as an unflagged counter reset, not a 40 TB/s disk", () => {
    const prev: ProcIoDeltaState = { at: 0, byKey: new Map([[KEY, { diskReadBytes: 0 }]]) };
    const r = computeProcIoRates(prev, [{ key: KEY, diskReadBytes: 2 ** 60 }], 1000);
    expect(r.ratesByKey.get(KEY)!.diskReadBps).toBe(0);
  });

  test("net counters follow the same rules as disk", () => {
    const t1 = computeProcIoRates(null, [{ key: KEY, netInBytes: 100, netOutBytes: 100 }], 1000);
    const t2 = computeProcIoRates(t1.next, [{ key: KEY, netInBytes: 1_100, netOutBytes: 100 }], 2000);
    expect(t2.ratesByKey.get(KEY)).toMatchObject({ netInBps: 1000, netOutBps: 0 });
  });

  test("keys of exited processes are dropped every tick, so a long session cannot leak", () => {
    const t1 = computeProcIoRates(null, [{ key: "1:1", diskReadBytes: 1 }, { key: "2:2", diskReadBytes: 1 }], 1000);
    const t2 = computeProcIoRates(t1.next, [{ key: "1:1", diskReadBytes: 2 }], 2000);
    expect([...t2.next.byKey.keys()]).toEqual(["1:1"]);
  });
});
