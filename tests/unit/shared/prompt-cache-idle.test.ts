import { describe, it, expect } from "bun:test";
import { idleCacheNotice, promptCacheStatus, formatIdleDuration, formatCacheCountdown, formatContextTokens, type PromptCacheState } from "../../../src/shared/prompt-cache-idle.ts";
import { PREFIX_WARN_TOKENS } from "../../../src/shared/turn-usage.ts";

const HOUR = 60 * 60_000;
const NOW = 1_800_000_000_000;

function state(over: Partial<PromptCacheState> = {}): PromptCacheState {
  return { lastTurnEndedAt: NOW - 2 * HOUR, ttlMs: HOUR, billedPrefixTokens: 199_000, ...over };
}

describe("idleCacheNotice", () => {
  it("reports how long the session has been idle", () => {
    expect(idleCacheNotice(state(), NOW)).toEqual({ idleMs: 2 * HOUR, reason: "expired" });
  });

  // `billedPrefixTokens` is a running session total — 67.7M against a 200k window on a real
  // session — so it may gate the notice and must never reach it as a figure. Only the
  // separately measured `contextTokens` is displayable.
  it("never promotes the summed prefix into a displayable figure", () => {
    expect(idleCacheNotice(state({ billedPrefixTokens: 67_700_000 }), NOW)).toEqual({
      idleMs: 2 * HOUR,
      reason: "expired",
    });
  });

  it("passes on a measured context size", () => {
    expect(idleCacheNotice(state({ contextTokens: 59_000 }), NOW)).toEqual({
      idleMs: 2 * HOUR,
      reason: "expired",
      contextTokens: 59_000,
    });
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

  it("says nothing about a session that has never billed enough to matter", () => {
    expect(idleCacheNotice(state({ billedPrefixTokens: PREFIX_WARN_TOKENS - 1 }), NOW)).toBeNull();
    expect(idleCacheNotice(state({ billedPrefixTokens: PREFIX_WARN_TOKENS }), NOW)).not.toBeNull();
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

describe("promptCacheStatus", () => {
  it("counts down while the cache is still warm", () => {
    expect(promptCacheStatus(state({ lastTurnEndedAt: NOW - 20 * 60_000 }), NOW)).toEqual({
      kind: "warm",
      remainingMs: 40 * 60_000,
    });
  });

  // The chip and the banner have to change together: one red chip with no banner, or a
  // banner beside a chip still counting down, asks the user to reconcile two readings of
  // one fact. Same three gates, asserted against the notice itself rather than restated.
  it("turns expired on exactly the tick that produces a notice", () => {
    for (const lastTurnEndedAt of [NOW - 59 * 60_000, NOW - HOUR, NOW - 6 * HOUR, NOW + HOUR]) {
      const s = state({ lastTurnEndedAt });
      expect(promptCacheStatus(s, NOW).kind === "cold").toBe(idleCacheNotice(s, NOW) != null);
    }
  });

  it("reports an unmeasured session as unknown rather than as a full window", () => {
    expect(promptCacheStatus(null, NOW)).toEqual({ kind: "unknown" });
    expect(promptCacheStatus({ ttlMs: HOUR }, NOW)).toEqual({ kind: "unknown" });
    expect(promptCacheStatus(state({ billedPrefixTokens: PREFIX_WARN_TOKENS - 1 }), NOW))
      .toEqual({ kind: "unknown" });
  });

  it("never offers more time than the window, however skewed the clock", () => {
    const skewed = promptCacheStatus(state({ lastTurnEndedAt: NOW + 5 * HOUR }), NOW);
    expect(skewed).toEqual({ kind: "warm", remainingMs: HOUR });
  });
});

describe("promptCacheStatus — compaction", () => {
  const warmAndCompacted = state({ lastTurnEndedAt: NOW - 30_000, compactedAt: NOW - 5 * 60_000 });

  // The cache is not stale, it is inapplicable: the prefix it holds is not the conversation
  // any more. A turn that finished thirty seconds ago is still cold.
  it("outranks a cache that is still well inside its window", () => {
    expect(promptCacheStatus(warmAndCompacted, NOW)).toEqual({
      kind: "cold", reason: "compacted", idleMs: 5 * 60_000,
    });
  });

  // Checked before the gates, so a session too small to have billed anything — or one with
  // no completed turn at all — is still reported cold once it has been compacted.
  it("outranks the floor and the never-measured case", () => {
    for (const over of [{ billedPrefixTokens: 1 }, { billedPrefixTokens: undefined, lastTurnEndedAt: undefined }]) {
      expect(promptCacheStatus(state({ ...over, compactedAt: NOW - 60_000 }), NOW).kind).toBe("cold");
    }
  });

  // What the next message re-caches is the summary the compaction produced, and no API call
  // has reported its size. A figure here would be the pre-compaction transcript — the one
  // thing that is certainly not being sent.
  it("offers no token figure, even when the session has one measured", () => {
    const n = idleCacheNotice(state({ compactedAt: NOW - 60_000, contextTokens: 59_000 }), NOW);
    expect(n).toEqual({ idleMs: 60_000, reason: "compacted" });
  });

  // The provider clears the flag on the first API call after the boundary, so an absent
  // `compactedAt` has to read as re-cached rather than as never-compacted.
  it("goes back to warm once the flag is cleared", () => {
    expect(promptCacheStatus(state({ lastTurnEndedAt: NOW - 30_000 }), NOW).kind).toBe("warm");
  });

  it("does not report a negative age on a clock skew", () => {
    const s = promptCacheStatus(state({ compactedAt: NOW + HOUR }), NOW);
    expect(s).toEqual({ kind: "cold", reason: "compacted", idleMs: 0 });
  });
});

describe("formatCacheCountdown", () => {
  // A fresh turn must read as the install's whole window, and the last partial minute must
  // never read `0m` — a zero says expired while the cache is still warm.
  it("rounds up, so it neither loses the first minute nor reaches zero", () => {
    expect(formatCacheCountdown(60 * 60_000)).toBe("60m");
    expect(formatCacheCountdown(59.4 * 60_000)).toBe("60m");
    expect(formatCacheCountdown(1_000)).toBe("1m");
    expect(formatCacheCountdown(0)).toBe("1m");
  });

  it("carries the API-key window as plain minutes", () => {
    expect(formatCacheCountdown(5 * 60_000)).toBe("5m");
  });
});

describe("formatContextTokens", () => {
  it("rounds to the precision the decision needs", () => {
    expect(formatContextTokens(59_000)).toBe("59k");
    expect(formatContextTokens(58_700)).toBe("59k");
    expect(formatContextTokens(1_400_000)).toBe("1.4M");
    expect(formatContextTokens(940)).toBe("940");
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
