import { describe, expect, test } from "bun:test";
import { createPresenceInputNotifier, PRESENCE_SEND_THROTTLE_MS } from "../../../src/web/lib/presence-input.ts";

function fakeClock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("createPresenceInputNotifier().notify", () => {
  test("50 inputs within 60s send exactly one message", () => {
    const sent: string[] = [];
    const clock = fakeClock(0);
    const { notify } = createPresenceInputNotifier((m) => { sent.push(m); return true; }, clock.now);
    for (let i = 0; i < 50; i++) {
      notify();
      clock.advance(1_000); // 50 inputs, 1s apart: 49s total, inside the window
    }
    expect(sent).toEqual([JSON.stringify({ type: "presence:input" })]);
  });

  test("sends again once the throttle window has fully elapsed", () => {
    const sent: number[] = [];
    const clock = fakeClock(0);
    const { notify } = createPresenceInputNotifier(() => { sent.push(clock.now()); return true; }, clock.now);
    notify();
    clock.advance(PRESENCE_SEND_THROTTLE_MS - 1);
    notify(); // still inside the window
    clock.advance(1);
    notify(); // exactly at the boundary: a new window
    expect(sent).toEqual([0, PRESENCE_SEND_THROTTLE_MS]);
  });

  test("a dropped send (socket not open yet) does not arm the throttle: the next input still goes through at once", () => {
    const sent: number[] = [];
    const clock = fakeClock(0);
    const { notify } = createPresenceInputNotifier(() => { sent.push(clock.now()); return false; }, clock.now);
    notify();
    clock.advance(1_000);
    notify();
    // Both attempts tried to send (the fake always reports failure); neither was swallowed by
    // the throttle, because a failed send never armed it.
    expect(sent).toEqual([0, 1_000]);
  });

  test("defaults to Date.now and the real global socket sender without throwing", () => {
    expect(() => createPresenceInputNotifier().notify()).not.toThrow();
  });
});

describe("createPresenceInputNotifier().retryIfPending", () => {
  test("is a no-op until a notify() has actually been dropped", () => {
    const sent: number[] = [];
    const clock = fakeClock(0);
    const { retryIfPending } = createPresenceInputNotifier(() => { sent.push(clock.now()); return true; }, clock.now);
    retryIfPending();
    expect(sent).toEqual([]);
  });

  test("resends a dropped input with no second call to notify()", () => {
    const sent: number[] = [];
    const clock = fakeClock(0);
    let open = false;
    const { notify, retryIfPending } = createPresenceInputNotifier(
      () => { if (!open) return false; sent.push(clock.now()); return true; },
      clock.now,
    );
    notify(); // page just loaded, socket still connecting: dropped, kept pending
    expect(sent).toEqual([]);
    clock.advance(5_000); // the socket takes 5s to connect; nobody touches the page meanwhile
    open = true;
    retryIfPending();
    expect(sent).toEqual([5_000]); // the original input is reported promptly, no second gesture
  });

  test("a successful retry still arms the throttle, so an input right after it is swallowed for the normal window", () => {
    const sent: number[] = [];
    const clock = fakeClock(0);
    let open = false;
    const { notify, retryIfPending } = createPresenceInputNotifier(
      () => { if (!open) return false; sent.push(clock.now()); return true; },
      clock.now,
    );
    notify();
    open = true;
    retryIfPending();
    clock.advance(1_000);
    notify(); // still inside the 60s window the retry started
    expect(sent).toEqual([0]);
  });

  test("does nothing once a retry has already delivered the pending input", () => {
    const sent: number[] = [];
    const clock = fakeClock(0);
    const { notify, retryIfPending } = createPresenceInputNotifier(() => { sent.push(clock.now()); return true; }, clock.now);
    notify(); // delivered immediately — nothing pending
    retryIfPending();
    retryIfPending();
    expect(sent).toEqual([0]);
  });
});
