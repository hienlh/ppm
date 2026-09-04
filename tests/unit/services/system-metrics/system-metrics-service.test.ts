import { describe, test, expect } from "bun:test";
import { SystemMetricsService, MAX_STREAM_SUBSCRIBERS } from "../../../../src/services/system-metrics/system-metrics.service.ts";
import type { PlatformCollectors } from "../../../../src/services/system-metrics/system-metrics-platform.ts";
import type { MetricsSnapshot } from "../../../../src/types/system-metrics.ts";
import { raw } from "./fixtures/process-fixtures.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(opts: { collectDelayMs?: number; intervalMs?: number } = {}) {
  const counters = { collects: 0, stops: 0, gpu: 0, diskNet: 0 };
  let clock = 1_000_000;
  const collectors: PlatformCollectors = {
    platform: "linux",
    processes: {
      collect: async () => {
        counters.collects++;
        if (opts.collectDelayMs) await sleep(opts.collectDelayMs);
        return { rows: [raw(1, 0, "systemd"), raw(500, 1, "node")], warnings: [] };
      },
      stop: () => { counters.stops++; },
    },
    diskNet: async () => { counters.diskNet++; return { disk: null, net: null, warnings: [] }; },
    gpus: { collect: async () => { counters.gpu++; return []; }, isDisabled: () => false },
  };
  const service = new SystemMetricsService({
    collectors,
    intervals: { full: opts.intervalMs ?? 30, light: opts.intervalMs ?? 30 },
    idleTeardownMs: 40,
    leaseTimeoutMs: 1000,
    now: () => clock,
    resolveProtected: () => ({ pids: new Set([500]), roots: new Set([500]), selfPid: 500 }),
    execute: async (pid, tree) => ({ pid, tree, method: "signal", killed: [pid] }),
    log: () => {},
    exitHooks: false,
  });
  const sub = (tier: "light" | "full") => {
    const frames: MetricsSnapshot[] = [];
    let closed = false;
    const r = service.subscribe({ tier, deliver: (s) => frames.push(s), close: () => { closed = true; } });
    return { r, frames, isClosed: () => closed };
  };
  return { service, counters, sub, advanceClock: (ms: number) => { clock += ms; } };
}

describe("SystemMetricsService — tiers gate collection", () => {
  test("a light subscriber alone never triggers a collector and receives light frames", async () => {
    const { service, counters, sub } = harness();
    const light = sub("light");
    expect(light.r?.tier).toBe("light");
    expect(light.r?.intervalMs).toBe(30);
    expect(service.activeTier()).toBe("light");
    await sleep(80);
    expect(light.frames.length).toBeGreaterThanOrEqual(2);
    expect(light.frames.every((f) => f.tier === "light" && f.processes.length === 0)).toBe(true);
    expect(counters).toEqual({ collects: 0, stops: 0, gpu: 0, diskNet: 0 });
    service.shutdown();
  });

  test("a full subscriber starts full collection; light subscribers get the projected view from the same tick", async () => {
    const { service, counters, sub } = harness();
    const light = sub("light");
    const full = sub("full");
    expect(service.activeTier()).toBe("full");
    await sleep(80);
    expect(counters.collects).toBeGreaterThanOrEqual(2);
    expect(full.frames.at(-1)!.processes).toHaveLength(2);
    expect(full.frames.at(-1)!.groups.length).toBeGreaterThan(0);
    const lastLight = light.frames.at(-1)!;
    expect(lastLight.tier).toBe("light");
    expect(lastLight.processes).toEqual([]);
    expect(service.getLatest("full")!.processes).toHaveLength(2);
    expect(service.getLatest("light")!.processes).toEqual([]);
    service.shutdown();
  });

  test("after the last full subscriber leaves, the timer drops to light and the child is torn down after the grace", async () => {
    const { service, counters, sub } = harness();
    sub("light");
    const full = sub("full");
    await sleep(40);
    service.unsubscribe(full.r!.sid);
    expect(service.activeTier()).toBe("light");
    expect(counters.stops).toBe(0);
    await sleep(70);
    expect(counters.stops).toBe(1);
    const collectsAfterLeave = counters.collects;
    await sleep(40);
    expect(counters.collects).toBe(collectsAfterLeave);
    service.shutdown();
  });

  test("a full subscriber returning within the grace cancels the teardown", async () => {
    const { service, counters, sub } = harness();
    const a = sub("full");
    await sleep(35);
    service.unsubscribe(a.r!.sid);
    await sleep(15);
    sub("full");
    await sleep(60);
    expect(counters.stops).toBe(0);
    service.shutdown();
  });

  test("no subscribers → no timer at all", async () => {
    const { service, counters, sub } = harness();
    const a = sub("light");
    service.unsubscribe(a.r!.sid);
    expect(service.activeTier()).toBeNull();
    await sleep(70);
    expect(counters.collects).toBe(0);
    expect(service.liveCount()).toBe(0);
  });
});

describe("SystemMetricsService — leases and cap", () => {
  test("silent subscribers are reaped after the lease timeout, closed, and the timer follows", async () => {
    const { service, sub, advanceClock } = harness();
    const full = sub("full");
    const pinged = sub("light");
    await sleep(35);
    advanceClock(900);
    expect(service.ping(pinged.r!.sid)).toBe(true);
    advanceClock(200);
    expect(service.reapExpired()).toBe(1);
    expect(full.isClosed()).toBe(true);
    expect(pinged.isClosed()).toBe(false);
    expect(service.activeTier()).toBe("light");
    expect(service.ping(full.r!.sid)).toBe(false);
    service.shutdown();
  });

  test("the cap counts live leases only: the 6th open is refused until a lease expires", async () => {
    const { service, sub, advanceClock } = harness();
    const subs = Array.from({ length: MAX_STREAM_SUBSCRIBERS }, () => sub("light"));
    expect(subs.every((s) => s.r !== null)).toBe(true);
    expect(sub("light").r).toBeNull();
    advanceClock(2000);
    // Reaping happens inside subscribe(): all five are silent → a slot frees.
    expect(sub("light").r).not.toBeNull();
    expect(service.liveCount()).toBe(1);
    service.shutdown();
  });

  test("unsubscribe is idempotent and unknown sids are rejected", () => {
    const { service, sub } = harness();
    const a = sub("light");
    expect(service.unsubscribe(a.r!.sid)).toBe(true);
    expect(service.unsubscribe(a.r!.sid)).toBe(false);
    expect(service.ping("nope")).toBe(false);
  });
});

describe("SystemMetricsService — tick discipline and kill", () => {
  test("an overlapping tick is dropped, not queued", async () => {
    const { service, counters, sub } = harness({ collectDelayMs: 60 });
    sub("full");
    await Promise.all([service.runTick(), service.runTick(), service.runTick()]);
    expect(counters.collects).toBe(1);
    service.shutdown();
  });

  test("a kill issued while a tick's collect() is pending waits for it and resolves — no busy rejection", async () => {
    const { service, counters, sub } = harness({ collectDelayMs: 60 });
    sub("full");
    const tick = service.runTick();
    await sleep(5); // the tick is now inside collect()
    const started = Date.now();
    const outcome = await service.kill({ pid: 500, startedAt: 0 });
    expect(outcome.status).toBe(403);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45); // it waited for the tick's collector
    await tick;
    expect(counters.collects).toBe(2); // one tick collection + one kill collection, strictly in sequence
    service.shutdown();
  });

  test("a tick that fires while a kill holds the collector is skipped, not overlapped", async () => {
    // Long interval so only the subscribe-triggered tick and our explicit runTick exist.
    const { service, counters, sub } = harness({ collectDelayMs: 60, intervalMs: 10_000 });
    sub("full");
    await sleep(70); // let the subscribe-triggered tick finish
    const before = counters.collects;
    const kill = service.kill({ pid: 1, startedAt: 0 });
    await sleep(5);
    await service.runTick(); // returns immediately
    expect(counters.collects).toBe(before + 1);
    await kill;
    service.shutdown();
  });

  test("a newcomer on an already-running tier receives the latest snapshot right away", async () => {
    const { service, sub } = harness();
    sub("light");
    await sleep(40);
    const late = sub("light");
    await sleep(0); // delivery is deferred one microtask so the session frame can go first
    expect(late.frames).toHaveLength(1);
    service.shutdown();
  });

  test("kill re-queries live, refuses protected, kills others, and arms the idle teardown when no window is open", async () => {
    const { service, counters } = harness();
    expect((await service.kill({ pid: 500, startedAt: 0 })).status).toBe(403);
    const ok = await service.kill({ pid: 1, startedAt: 0 });
    // pid 1 is init on posix → refused by the guard, still a real re-query.
    expect(ok.status).toBe(403);
    expect(counters.collects).toBe(2);
    await sleep(60);
    expect(counters.stops).toBe(1);
  });

  test("shutdown closes every subscriber and stops the child", () => {
    const { service, counters, sub } = harness();
    const a = sub("full");
    service.shutdown();
    expect(a.isClosed()).toBe(true);
    expect(service.liveCount()).toBe(0);
    expect(service.activeTier()).toBeNull();
    expect(counters.stops).toBeGreaterThanOrEqual(1);
  });
});
