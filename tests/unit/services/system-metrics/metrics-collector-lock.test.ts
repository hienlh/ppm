import { describe, expect, test } from "bun:test";
import { CollectorLock } from "../../../../src/services/system-metrics/metrics-collector-lock.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CollectorLock", () => {
  test("tryRun runs when free, is held for the awaited work, and releases after", async () => {
    const lock = new CollectorLock();
    expect(lock.isHeld()).toBe(false);
    // `isHeld` turns true once the work yields — the lock is assigned after
    // `work()` returns its promise, and nothing else can run before that.
    const run = lock.tryRun(async () => { await sleep(10); return "done"; });
    await sleep(1);
    expect(lock.isHeld()).toBe(true);
    expect(await run).toBe("done");
    expect(lock.isHeld()).toBe(false);
  });

  test("tryRun skips with null while another holder runs — the work is never started", async () => {
    const lock = new CollectorLock();
    let started = 0;
    const work = async () => { started++; await sleep(30); return "first"; };
    const [a, b, c] = await Promise.all([lock.tryRun(work), lock.tryRun(work), lock.tryRun(work)]);
    expect([a, b, c]).toEqual(["first", null, null]);
    expect(started).toBe(1);
  });

  test("runExclusive waits for the current holder, then runs — strictly in sequence", async () => {
    const lock = new CollectorLock();
    const order: string[] = [];
    const held = lock.tryRun(async () => { await sleep(30); order.push("holder"); });
    await sleep(5);
    const queued = lock.runExclusive(async () => { order.push("exclusive"); return 7; });
    expect(await queued).toBe(7);
    await held;
    expect(order).toEqual(["holder", "exclusive"]);
  });

  test("a holder that throws still releases the lock and does not poison the waiter", async () => {
    const lock = new CollectorLock();
    const boom = lock.tryRun(async () => { await sleep(20); throw new Error("collector down"); });
    await sleep(5);
    const after = lock.runExclusive(async () => "ok");
    expect(await after).toBe("ok");
    await expect(boom).rejects.toThrow("collector down");
    expect(lock.isHeld()).toBe(false);
  });

  test("runExclusive callers are serialised against each other", async () => {
    const lock = new CollectorLock();
    let concurrent = 0;
    let peak = 0;
    const work = async () => {
      peak = Math.max(peak, ++concurrent);
      await sleep(10);
      concurrent--;
    };
    await Promise.all([lock.runExclusive(work), lock.runExclusive(work), lock.runExclusive(work)]);
    expect(peak).toBe(1);
  });
});
