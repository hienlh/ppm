import { describe, expect, it } from "bun:test";
import { AI_MAX_QUEUE_WAIT_MS, ExtensionAiLimiter } from "../../../src/services/extension-ai/extension-ai-limiter.ts";
import { aiCompleteRpcTimeoutMs } from "../../../packages/vscode-compat/src/ppm/ppm-ai.ts";

/** A clock the test moves by hand. */
function manualTimers() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
  };
}

const codeOf = (p: Promise<unknown>) => p.then(() => "resolved", (e) => (e as { code: string }).code);

describe("ExtensionAiLimiter", () => {
  it("runs four calls per extension at once and queues the fifth until one ends", async () => {
    const limiter = new ExtensionAiLimiter({ setTimer: () => 0, clearTimer: () => {} });
    const releases = await Promise.all([1, 2, 3, 4].map(() => limiter.acquire("ext")));
    let fifthAdmitted = false;
    const fifth = limiter.acquire("ext").then((r) => { fifthAdmitted = true; return r; });
    await Promise.resolve();
    expect(fifthAdmitted).toBe(false);
    expect(limiter.stats("ext")).toEqual({ running: 4, queued: 1 });
    // Another extension has a lane of its own.
    (await limiter.acquire("other"))();
    releases[0]!();
    releases[0]!(); // releasing twice frees one slot, not two
    (await fifth)();
    expect(fifthAdmitted).toBe(true);
    expect(limiter.stats("ext")).toEqual({ running: 3, queued: 0 });
    for (const r of releases.slice(1)) r();
    expect(limiter.stats("ext")).toEqual({ running: 0, queued: 0 });
  });

  it("refuses past 32 waiting with QUEUE_FULL", async () => {
    const limiter = new ExtensionAiLimiter({ setTimer: () => 0, clearTimer: () => {} });
    for (let i = 0; i < 4; i++) await limiter.acquire("ext");
    for (let i = 0; i < 32; i++) void limiter.acquire("ext");
    expect(await codeOf(limiter.acquire("ext"))).toBe("QUEUE_FULL");
  });

  it("fails a call that waited 61 s with QUEUE_TIMEOUT, before the worker's RPC deadline", async () => {
    const clock = manualTimers();
    const limiter = new ExtensionAiLimiter(clock);
    for (let i = 0; i < 4; i++) await limiter.acquire("ext");
    const waiting = codeOf(limiter.acquire("ext"));
    clock.advance(AI_MAX_QUEUE_WAIT_MS - 1);
    clock.advance(2);
    expect(await waiting).toBe("QUEUE_TIMEOUT");
    expect(limiter.stats("ext").queued).toBe(0);
    // The worker gives the RPC the call's own timeout plus this wait plus a margin, so even
    // the shortest call hears QUEUE_TIMEOUT, not its own RPC timeout.
    expect(AI_MAX_QUEUE_WAIT_MS + 1).toBeLessThan(aiCompleteRpcTimeoutMs({ timeoutMs: 5_000 }));
  });

  it("takes a cancelled call out of the line without spending its turn", async () => {
    const clock = manualTimers();
    const limiter = new ExtensionAiLimiter(clock);
    const releases = await Promise.all([1, 2, 3, 4].map(() => limiter.acquire("ext")));
    const controller = new AbortController();
    const cancelled = codeOf(limiter.acquire("ext", controller.signal));
    const next = limiter.acquire("ext");
    controller.abort();
    expect(await cancelled).toBe("ABORTED");
    expect(clock.pending()).toBe(1); // the cancelled waiter's timer is gone
    releases[0]!();
    (await next)();
    expect(await codeOf(limiter.acquire("ext", AbortSignal.abort()))).toBe("ABORTED");
  });

  it("caps calls across every extension at eight, however many names they arrive under", async () => {
    const limiter = new ExtensionAiLimiter({ setTimer: () => 0, clearTimer: () => {} });
    const releases: (() => void)[] = [];
    for (let i = 0; i < 8; i++) releases.push(await limiter.acquire(`ext-${i}`));
    let ninthAdmitted = false;
    const ninth = limiter.acquire("ext-new").then((r) => { ninthAdmitted = true; return r; });
    await Promise.resolve();
    expect(ninthAdmitted).toBe(false);
    expect(limiter.totalRunning()).toBe(8);
    releases[3]!();
    (await ninth)();
    expect(ninthAdmitted).toBe(true);
    for (const r of releases) r();
    expect(limiter.totalRunning()).toBe(0);
  });

  it("admits a waiter whose own lane has room before one whose lane is full", async () => {
    const limiter = new ExtensionAiLimiter({ maxInFlight: 2, maxTotal: 3, setTimer: () => 0, clearTimer: () => {} });
    const a1 = await limiter.acquire("a");
    await limiter.acquire("a");
    const b1 = await limiter.acquire("b");
    const order: string[] = [];
    void limiter.acquire("a").then((r) => { order.push("a"); return r; });
    void limiter.acquire("b").then((r) => { order.push("b"); return r; });
    b1();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["b"]);
    a1();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["b", "a"]);
  });
});
