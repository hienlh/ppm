import { describe, expect, it } from "bun:test";
import { waitTurnIdle } from "../../../src/services/chat-control/wait-turn-idle.ts";

/** A clock that only moves when the waiter sleeps, so no test waits for real time. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { slept.push(ms); t += ms; },
    slept,
  };
}

describe("waitTurnIdle", () => {
  it("answers at once when the turn is already over", async () => {
    const clock = fakeClock();
    expect(await waitTurnIdle(() => false, clock)).toBe(true);
    expect(clock.slept).toEqual([]);
  });

  it("polls every interval until the turn ends", async () => {
    const clock = fakeClock();
    let checks = 0;
    expect(await waitTurnIdle(() => ++checks < 4, { ...clock, intervalMs: 100 })).toBe(true);
    expect(clock.slept).toEqual([100, 100, 100]);
  });

  it("gives up after the timeout when the turn never ends", async () => {
    const clock = fakeClock();
    expect(await waitTurnIdle(() => true, { ...clock, intervalMs: 100, timeoutMs: 1_000 })).toBe(false);
    expect(clock.now()).toBe(1_000);
    expect(clock.slept.length).toBe(10);
  });

  it("defaults to a 100 ms poll and a 10 s limit", async () => {
    const clock = fakeClock();
    expect(await waitTurnIdle(() => true, clock)).toBe(false);
    expect(clock.slept[0]).toBe(100);
    expect(clock.now()).toBe(10_000);
  });
});
