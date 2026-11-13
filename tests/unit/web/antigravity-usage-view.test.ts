import { describe, expect, test } from "bun:test";
import { currentAntigravityUsage, isAntigravityUsageStale } from "../../../src/web/lib/antigravity-usage-view";
import type { LimitBucket } from "../../../src/types/chat";

const NOW = Date.parse("2026-11-08T08:40:00Z");

function bucket(utilization: number, resetsAt: string, windowHours = 5): LimitBucket {
  return { utilization, resetsAt, resetsInMinutes: 30, resetsInHours: null, windowHours };
}

describe("currentAntigravityUsage", () => {
  test("a window whose reset time has passed reads as started over, flat fields included", () => {
    // The reading PPM held while the app was closed: 18% with a reset seven hours ago.
    const u = currentAntigravityUsage({
      session: bucket(0.18, "2026-11-08T01:45:00Z"),
      fiveHour: 0.18,
      weekly: bucket(0.25, "2026-11-13T23:45:00Z", 168),
      sevenDay: 0.25,
    }, NOW);
    expect(u.session).toMatchObject({ utilization: 0, resetsAt: "", resetsInMinutes: null, resetsInHours: null });
    expect(u.fiveHour).toBe(0);
    expect(u.weekly).toMatchObject({ utilization: 0.25, resetsAt: "2026-11-13T23:45:00Z" });
    expect(u.sevenDay).toBe(0.25);
  });

  test("a scoped bucket at its cap stays at its cap until its reset", () => {
    const u = currentAntigravityUsage({
      weeklyScoped: [{ ...bucket(1, "2026-11-13T07:16:43Z", 168), label: "Claude and GPT models · Weekly" }],
    }, NOW);
    expect(u.weeklyScoped?.[0]).toMatchObject({ utilization: 1, resetsAt: "2026-11-13T07:16:43Z", label: "Claude and GPT models · Weekly" });
  });

  test("an unused window shows no reset time, as the Antigravity app does", () => {
    // The server answers "now + 5 h" for a window nobody has used yet.
    const u = currentAntigravityUsage({
      weeklyScoped: [{ ...bucket(0, "2026-11-08T13:36:21Z"), label: "Claude and GPT models · 5-Hour" }],
    }, NOW);
    expect(u.weeklyScoped?.[0]).toMatchObject({ utilization: 0, resetsAt: "", resetsInMinutes: null });
  });

  test("leaves absent buckets absent", () => {
    expect(currentAntigravityUsage({ activeAccountId: "default" }, NOW)).toEqual({ activeAccountId: "default" });
  });
});

describe("isAntigravityUsageStale", () => {
  test("a reading from the last sweep is fresh, one that missed two sweeps is stale", () => {
    expect(isAntigravityUsageStale(new Date(NOW - 6 * 60_000).toISOString(), NOW)).toBe(false);
    expect(isAntigravityUsageStale(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe(true);
  });

  test("no reading time says nothing about staleness", () => {
    expect(isAntigravityUsageStale(undefined, NOW)).toBe(false);
    expect(isAntigravityUsageStale("not a date", NOW)).toBe(false);
  });
});
