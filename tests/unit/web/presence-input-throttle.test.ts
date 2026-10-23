import { describe, expect, test } from "bun:test";
import { createPresenceInputNotifier, PRESENCE_SEND_THROTTLE_MS } from "../../../src/web/lib/presence-input.ts";

function fakeClock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("createPresenceInputNotifier", () => {
  test("50 inputs within 60s send exactly one message", () => {
    const sent: string[] = [];
    const clock = fakeClock(0);
    const notify = createPresenceInputNotifier((m) => { sent.push(m); return true; }, clock.now);
    for (let i = 0; i < 50; i++) {
      notify();
      clock.advance(1_000); // 50 inputs, 1s apart: 49s total, inside the window
    }
    expect(sent).toEqual([JSON.stringify({ type: "presence:input" })]);
  });

  test("sends again once the throttle window has fully elapsed", () => {
    const sent: number[] = [];
    const clock = fakeClock(0);
    const notify = createPresenceInputNotifier(() => { sent.push(clock.now()); return true; }, clock.now);
    notify();
    clock.advance(PRESENCE_SEND_THROTTLE_MS - 1);
    notify(); // still inside the window
    clock.advance(1);
    notify(); // exactly at the boundary: a new window
    expect(sent).toEqual([0, PRESENCE_SEND_THROTTLE_MS]);
  });

  test("a dropped send (socket not open) still arms the throttle, matching sendIfOpen's own contract", () => {
    const sent: number[] = [];
    const clock = fakeClock(0);
    const notify = createPresenceInputNotifier(() => { sent.push(clock.now()); return false; }, clock.now);
    notify();
    clock.advance(1_000);
    notify();
    expect(sent).toEqual([0]);
  });

  test("defaults to Date.now and the real global socket sender without throwing", () => {
    expect(() => createPresenceInputNotifier()()).not.toThrow();
  });
});
