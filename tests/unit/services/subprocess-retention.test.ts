import { describe, expect, test } from "bun:test";
import {
  cacheReleaseDelayMs,
  selectWarmIdleEvictions,
  PROMPT_CACHE_TTL_MS,
} from "../../../src/services/subprocess-retention.ts";

/**
 * These lock in the timing the cache fix depends on. Restoring a teardown that fires on
 * disconnect, or timing the retention window off the disconnect instead of the last turn,
 * has to break something here.
 */
describe("cacheReleaseDelayMs", () => {
  const now = 1_000_000_000;

  test("releases immediately when no turn has completed", () => {
    // Nothing has been written to the cache, so the subprocess protects nothing.
    expect(cacheReleaseDelayMs(undefined, now)).toBe(0);
  });

  test("waits out the remainder of the TTL from the last turn, not from now", () => {
    // Turn ended 2 minutes ago → 3 of the 5 minutes remain. Timing this from the disconnect
    // instead would hold the subprocess for a further full 5 minutes. The window is passed
    // explicitly so the assertion states the behaviour, not whatever the default happens to be.
    const ttl = 5 * 60_000;
    const twoMinutesAgo = now - 2 * 60_000;
    expect(cacheReleaseDelayMs(twoMinutesAgo, now, ttl)).toBe(3 * 60_000);
  });

  test("gives the full window to a turn that just finished", () => {
    expect(cacheReleaseDelayMs(now, now)).toBe(PROMPT_CACHE_TTL_MS);
  });

  test("releases immediately once the cache has already lapsed", () => {
    // The old behaviour — free it on disconnect — is correct in exactly this case.
    expect(cacheReleaseDelayMs(now - PROMPT_CACHE_TTL_MS, now)).toBe(0);
    expect(cacheReleaseDelayMs(now - 60 * 60_000, now)).toBe(0);
  });

  test("never returns a negative delay", () => {
    expect(cacheReleaseDelayMs(now - 10 * PROMPT_CACHE_TTL_MS, now)).toBeGreaterThanOrEqual(0);
  });

  test("honours a caller-supplied TTL", () => {
    expect(cacheReleaseDelayMs(now, now, 60_000)).toBe(60_000);
  });
});

describe("selectWarmIdleEvictions", () => {
  const sessions = (...idle: number[]) =>
    idle.map((idleSince, i) => ({ sessionId: `s${i}`, idleSince }));

  test("evicts nothing while at or under the cap", () => {
    expect(selectWarmIdleEvictions(sessions(1, 2, 3), 5)).toEqual([]);
    expect(selectWarmIdleEvictions(sessions(1, 2, 3, 4, 5), 5)).toEqual([]);
  });

  test("evicts the longest-idle sessions first", () => {
    // s2 has been idle longest (smallest timestamp), so its cache is closest to expiring.
    const picked = selectWarmIdleEvictions(
      [
        { sessionId: "recent", idleSince: 300 },
        { sessionId: "oldest", idleSince: 100 },
        { sessionId: "middle", idleSince: 200 },
      ],
      2,
    );
    expect(picked).toEqual(["oldest"]);
  });

  test("evicts exactly the overflow, in eviction order", () => {
    const picked = selectWarmIdleEvictions(sessions(50, 10, 40, 20, 30), 2);
    expect(picked).toHaveLength(3);
    expect(picked).toEqual(["s1", "s3", "s4"]); // idle 10, 20, 30
  });

  test("treats a session with no idle timestamp as the longest idle", () => {
    const picked = selectWarmIdleEvictions(
      [
        { sessionId: "timed", idleSince: 100 },
        { sessionId: "untimed" },
      ],
      1,
    );
    expect(picked).toEqual(["untimed"]);
  });

  test("does not mutate the caller's array", () => {
    const input = sessions(50, 10, 40);
    const before = input.map((s) => s.sessionId);
    selectWarmIdleEvictions(input, 1);
    expect(input.map((s) => s.sessionId)).toEqual(before);
  });

  test("a cap of zero releases every held subprocess", () => {
    expect(selectWarmIdleEvictions(sessions(1, 2), 0)).toHaveLength(2);
  });

  test("an empty set evicts nothing", () => {
    expect(selectWarmIdleEvictions([], 5)).toEqual([]);
  });
});
