import { describe, it, expect } from "bun:test";
import { idleCacheNotice, formatIdleDuration, type PromptCacheState } from "../../../src/shared/prompt-cache-idle.ts";
import { PREFIX_WARN_TOKENS } from "../../../src/shared/turn-usage.ts";

const HOUR = 60 * 60_000;
const NOW = 1_800_000_000_000;

function state(over: Partial<PromptCacheState> = {}): PromptCacheState {
  return { lastTurnEndedAt: NOW - 2 * HOUR, ttlMs: HOUR, prefixTokens: 199_000, ...over };
}

describe("idleCacheNotice", () => {
  it("reports the idle time and what the next message would re-cache", () => {
    expect(idleCacheNotice(state(), NOW)).toEqual({ idleMs: 2 * HOUR, prefixTokens: 199_000 });
  });

  it("stays silent while the cache is still inside its window", () => {
    expect(idleCacheNotice(state({ lastTurnEndedAt: NOW - 59 * 60_000 }), NOW)).toBeNull();
  });

  it("fires the moment the window is reached, not a tick later", () => {
    expect(idleCacheNotice(state({ lastTurnEndedAt: NOW - HOUR }), NOW)).not.toBeNull();
  });

  it("honours the shorter API-key window rather than assuming an hour", () => {
    const tenMinutesIdle = { lastTurnEndedAt: NOW - 10 * 60_000 };
    expect(idleCacheNotice(state({ ...tenMinutesIdle, ttlMs: HOUR }), NOW)).toBeNull();
    expect(idleCacheNotice(state({ ...tenMinutesIdle, ttlMs: 5 * 60_000 }), NOW)).not.toBeNull();
  });

  it("says nothing about a transcript small enough to be cheap either way", () => {
    expect(idleCacheNotice(state({ prefixTokens: PREFIX_WARN_TOKENS - 1 }), NOW)).toBeNull();
    expect(idleCacheNotice(state({ prefixTokens: PREFIX_WARN_TOKENS }), NOW)).not.toBeNull();
  });

  it("treats an unmeasured session as unknown, not as expired", () => {
    expect(idleCacheNotice(null, NOW)).toBeNull();
    expect(idleCacheNotice(undefined, NOW)).toBeNull();
    // The shape a session has before its first turn completes: the install's window is
    // known, the conversation has nothing cached to lose.
    expect(idleCacheNotice({ ttlMs: HOUR }, NOW)).toBeNull();
    expect(idleCacheNotice({ ttlMs: HOUR, lastTurnEndedAt: NOW - 2 * HOUR }, NOW)).toBeNull();
  });

  it("does not warn on a clock skew that puts the last turn in the future", () => {
    expect(idleCacheNotice(state({ lastTurnEndedAt: NOW + HOUR }), NOW)).toBeNull();
  });
});

describe("formatIdleDuration", () => {
  it("matches the hours-and-minutes wording for a long idle", () => {
    expect(formatIdleDuration(10 * HOUR + 39 * 60_000)).toBe("10h 39m");
  });

  it("drops a zero component rather than printing it", () => {
    expect(formatIdleDuration(3 * HOUR)).toBe("3h");
    expect(formatIdleDuration(48 * HOUR)).toBe("2d");
  });

  it("drops minutes past a day", () => {
    expect(formatIdleDuration(2 * 24 * HOUR + 7 * HOUR + 13 * 60_000)).toBe("2d 7h");
  });

  it("never rounds a real idle down to zero minutes", () => {
    expect(formatIdleDuration(30_000)).toBe("1m");
    expect(formatIdleDuration(6 * 60_000)).toBe("6m");
  });
});
