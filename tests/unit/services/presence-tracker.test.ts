import { describe, expect, test } from "bun:test";
import { PresenceTracker } from "../../../src/services/presence-tracker.ts";

const MIN = 60_000;
const WINDOW = 10 * MIN;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("PresenceTracker", () => {
  test("never input: not active, nothing to report", () => {
    const tracker = new PresenceTracker(WINDOW);
    expect(tracker.presence(T0)).toEqual({ lastInputAt: null, idleMs: null, active: false, activeWindowMs: WINDOW });
  });

  test("active inside the window, inactive once it idles past it", () => {
    const tracker = new PresenceTracker(WINDOW);
    tracker.noteUserInput(T0);
    expect(tracker.presence(T0 + 9 * MIN)).toEqual({
      lastInputAt: new Date(T0).toISOString(), idleMs: 9 * MIN, active: true, activeWindowMs: WINDOW,
    });
    expect(tracker.presence(T0 + 11 * MIN).active).toBe(false);
  });

  test("exactly at the window boundary is still active", () => {
    const tracker = new PresenceTracker(WINDOW);
    tracker.noteUserInput(T0);
    expect(tracker.presence(T0 + WINDOW).active).toBe(true);
    expect(tracker.presence(T0 + WINDOW + 1).active).toBe(false);
  });

  test("a later input resets idle time, even after the window had lapsed", () => {
    const tracker = new PresenceTracker(WINDOW);
    tracker.noteUserInput(T0);
    expect(tracker.presence(T0 + 20 * MIN).active).toBe(false);
    tracker.noteUserInput(T0 + 20 * MIN);
    expect(tracker.presence(T0 + 20 * MIN + MIN)).toMatchObject({ idleMs: MIN, active: true });
  });

  test("defaults to the real clock when called with no arguments", () => {
    const tracker = new PresenceTracker(WINDOW);
    const before = Date.now();
    tracker.noteUserInput();
    const snapshot = tracker.presence();
    expect(snapshot.active).toBe(true);
    expect(Date.parse(snapshot.lastInputAt!)).toBeGreaterThanOrEqual(before);
  });

  test("two trackers never share state", () => {
    const a = new PresenceTracker(WINDOW);
    const b = new PresenceTracker(WINDOW);
    a.noteUserInput(T0);
    expect(b.presence(T0).active).toBe(false);
  });
});
