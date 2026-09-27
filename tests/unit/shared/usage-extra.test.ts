/**
 * Usage details with no fixed column: Claude's per-model weekly limits and Codex's free
 * rate-limit reset credits. Fixtures are trimmed copies of real payloads (27/9/2026).
 */
import { describe, it, expect } from "bun:test";
import {
  parseClaudeScopedLimits, parseCodexResetCredits, serializeUsageExtra, deserializeUsageExtra,
  usageExtraSignature, scopedBucket,
} from "../../../src/shared/usage-extra.ts";

/** `GET /api/oauth/usage`: Fable only appears in `limits[]`; the legacy per-model keys are null. */
const CLAUDE_USAGE = {
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: "session", group: "session", percent: 7, resets_at: "2026-09-27T06:49:59.720022+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 34, resets_at: "2026-10-01T08:59:59.720048+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 3, resets_at: "2026-10-01T09:00:00.364033+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null } },
  ],
};

const future = Math.floor(Date.now() / 1000) + 30 * 86400;
/** `account/rateLimits/read` → `rateLimitResetCredits`. */
const CODEX_RATE_LIMITS = {
  rateLimitResetCredits: {
    availableCount: 3,
    credits: [
      { id: "a", resetType: "codexRateLimits", status: "available", grantedAt: 1, expiresAt: future + 100, title: "Full reset (Weekly + 5 hr)" },
      { id: "b", resetType: "codexRateLimits", status: "available", grantedAt: 1, expiresAt: future, title: "Full reset" },
      { id: "c", resetType: "codexRateLimits", status: "used", grantedAt: 1, expiresAt: future },
      { id: "d", resetType: "codexRateLimits", status: "available", grantedAt: 1, expiresAt: 1000 },
    ],
  },
};

describe("claude per-model weekly limits", () => {
  it("reads Fable out of limits[] as a 0-1 fraction, labelled by model", () => {
    expect(parseClaudeScopedLimits(CLAUDE_USAGE)).toEqual([
      { label: "Fable", utilization: 0.03, resetsAt: "2026-10-01T09:00:00.364033+00:00" },
    ]);
  });

  it("ignores unscoped limits, unnamed scopes and payloads without limits", () => {
    expect(parseClaudeScopedLimits({ limits: [{ kind: "weekly_scoped", percent: 5, scope: { model: {} } }] })).toEqual([]);
    expect(parseClaudeScopedLimits({})).toEqual([]);
    expect(parseClaudeScopedLimits(null)).toEqual([]);
  });

  it("recomputes a weekly countdown for the bar", () => {
    const b = scopedBucket({ label: "Fable", utilization: 0.03, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() });
    expect(b.windowHours).toBe(168);
    expect(b.resetsInHours).toBeGreaterThan(1.9);
    expect(b.resetsInMinutes).toBeNull();
  });
});

describe("codex reset credits", () => {
  it("counts only available, unexpired credits and names the soonest to lapse", () => {
    const c = parseCodexResetCredits(CODEX_RATE_LIMITS)!;
    expect(c.available).toBe(2);
    expect(c.nextExpiresAt).toBe(new Date(future * 1000).toISOString());
    expect(c.title).toBe("Full reset");
  });

  it("tells 'none reported' apart from 'zero left'", () => {
    expect(parseCodexResetCredits({})).toBeUndefined();
    expect(parseCodexResetCredits({ rateLimitResetCredits: { credits: [] } })).toEqual({ available: 0 });
  });
});

describe("storage round trip", () => {
  it("survives the JSON column and back", () => {
    const weeklyScoped = parseClaudeScopedLimits(CLAUDE_USAGE).map(scopedBucket);
    const resetCredits = parseCodexResetCredits(CODEX_RATE_LIMITS);
    const back = deserializeUsageExtra(serializeUsageExtra({ weeklyScoped, resetCredits }));
    expect(back.weeklyScoped?.[0]?.label).toBe("Fable");
    expect(back.weeklyScoped?.[0]?.utilization).toBe(0.03);
    expect(back.resetCredits).toEqual(resetCredits);
  });

  it("writes nothing when there is nothing, and reads bad JSON as nothing", () => {
    expect(serializeUsageExtra({})).toBeNull();
    expect(deserializeUsageExtra("{not json")).toEqual({});
    expect(deserializeUsageExtra(null)).toEqual({});
  });

  it("does not count reset-time jitter as a change, but does count a moved percent or a spent credit", () => {
    const at = (resetsAt: string, u = 0.03, n = 2) => serializeUsageExtra({
      weeklyScoped: [scopedBucket({ label: "Fable", utilization: u, resetsAt })],
      resetCredits: { available: n },
    });
    const base = usageExtraSignature(at("2026-10-01T08:59:59.720048+00:00"));
    expect(usageExtraSignature(at("2026-10-01T09:00:00.364033+00:00"))).toBe(base);
    expect(usageExtraSignature(at("2026-10-01T09:00:00Z", 0.05))).not.toBe(base);
    expect(usageExtraSignature(at("2026-10-01T09:00:00Z", 0.03, 1))).not.toBe(base);
  });
});
