import { describe, expect, test } from "bun:test";
import { buildUsageSummary, type UsageAccountSource } from "../../../src/services/extension-api/extension-usage-summary.ts";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const FUTURE = new Date(NOW + 3_600_000).toISOString(); // +1h
const PAST = new Date(NOW - 3_600_000).toISOString(); // -1h

function bucket(utilization: number, resetsAt: string, windowHours = 5) {
  return { utilization, resetsAt, resetsInMinutes: null, resetsInHours: null, windowHours };
}

describe("buildUsageSummary", () => {
  test("a Claude account at 0.42 utilisation reads usedPct: 42, with no keys outside the contract", () => {
    const account: UsageAccountSource = {
      provider: "claude", accountId: "acc-1", status: "active",
      usage: { session: bucket(0.42, FUTURE), lastFetchedAt: new Date(NOW - 1000).toISOString() },
    };
    const result = buildUsageSummary(NOW, [account]);
    expect(result.now).toBe(new Date(NOW).toISOString());
    expect(result.accounts).toHaveLength(1);
    const row = result.accounts[0]!;
    expect(row.fiveHour!.usedPct).toBe(42);
    expect(Object.keys(row).sort()).toEqual(
      ["accountId", "ageMs", "alias", "fetchedAt", "fiveHour", "provider", "status"].sort(),
    );
    expect(Object.keys(row.fiveHour!).sort()).toEqual(["resetsAt", "resetsInMs", "usedPct"].sort());
  });

  test("forbidden fields never reach the output even if a caller's object carries them", () => {
    const poisoned = {
      provider: "claude", accountId: "acc-1", status: "active",
      // A future caller might widen the type and pass these through by accident; the mapper
      // must never read or copy them regardless.
      email: "person@example.com", profileData: { account: {} }, accessToken: "sk-ant-oat-x",
      usage: { session: bucket(0.1, FUTURE), lastFetchedAt: null },
    } as unknown as UsageAccountSource;
    const row = buildUsageSummary(NOW, [poisoned]).accounts[0]!;
    const keys = Object.keys(row);
    for (const forbidden of ["email", "profileData", "home", "accessToken", "label"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test('Claude\'s "" reset time and an unparsable one both become null', () => {
    const account: UsageAccountSource = {
      provider: "claude", accountId: "acc-1", status: "active",
      usage: { session: bucket(0.1, ""), weekly: bucket(0.2, "not-a-date", 168) },
    };
    const row = buildUsageSummary(NOW, [account]).accounts[0]!;
    expect(row.fiveHour).toEqual({ usedPct: 10, resetsAt: null, resetsInMs: null });
    expect(row.weekly).toEqual({ usedPct: 20, resetsAt: null, resetsInMs: null });
  });

  test("a reset time already in the past becomes null, but usedPct is kept", () => {
    const account: UsageAccountSource = {
      provider: "claude", accountId: "acc-1", status: "active",
      usage: { session: bucket(0.75, PAST) },
    };
    const row = buildUsageSummary(NOW, [account]).accounts[0]!;
    expect(row.fiveHour).toEqual({ usedPct: 75, resetsAt: null, resetsInMs: null });
  });

  test("a future reset time carries through as an ISO string and a positive resetsInMs", () => {
    const account: UsageAccountSource = {
      provider: "claude", accountId: "acc-1", status: "active",
      usage: { session: bucket(0.5, FUTURE) },
    };
    const row = buildUsageSummary(NOW, [account]).accounts[0]!;
    expect(row.fiveHour).toEqual({ usedPct: 50, resetsAt: FUTURE, resetsInMs: 3_600_000 });
  });

  test("weeklyByModel lists Opus, then Sonnet, then any per-model scoped buckets, each only when present", () => {
    const account: UsageAccountSource = {
      provider: "claude", accountId: "acc-1", status: "active",
      usage: {
        weeklyOpus: bucket(0.3, FUTURE, 168),
        weeklySonnet: bucket(0.6, FUTURE, 168),
        weeklyScoped: [{ ...bucket(0.9, FUTURE, 168), label: "Fable" }],
      },
    };
    const row = buildUsageSummary(NOW, [account]).accounts[0]!;
    expect(row.weeklyByModel).toEqual([
      { usedPct: 30, resetsAt: FUTURE, resetsInMs: 3_600_000, label: "Opus" },
      { usedPct: 60, resetsAt: FUTURE, resetsInMs: 3_600_000, label: "Sonnet" },
      { usedPct: 90, resetsAt: FUTURE, resetsInMs: 3_600_000, label: "Fable" },
    ]);
  });

  test("weeklyByModel is absent, not an empty array, when there is nothing per-model", () => {
    const account: UsageAccountSource = { provider: "claude", accountId: "acc-1", status: "active", usage: {} };
    const row = buildUsageSummary(NOW, [account]).accounts[0]!;
    expect(row.weeklyByModel).toBeUndefined();
    expect(row.fiveHour).toBeUndefined();
    expect(row.weekly).toBeUndefined();
  });

  test("disabled accounts are included, carrying their status, never skipped by the mapper", () => {
    const account: UsageAccountSource = { provider: "codex", accountId: "acc-x", status: "disabled", usage: {} };
    const row = buildUsageSummary(NOW, [account]).accounts[0]!;
    expect(row.status).toBe("disabled");
  });

  test("alias is a neutral, 1-based label by stable per-provider order; a Codex account's email-shaped label never leaks", () => {
    const accounts: UsageAccountSource[] = [
      { provider: "claude", accountId: "c1", status: "active", usage: {} },
      { provider: "codex", accountId: "x1", status: "active", usage: {} },
      { provider: "claude", accountId: "c2", status: "active", usage: {} },
      { provider: "codex", accountId: "x2", status: "active", usage: {} },
    ];
    const rows = buildUsageSummary(NOW, accounts).accounts;
    expect(rows.map((r) => r.alias)).toEqual(["Claude 1", "Codex 1", "Claude 2", "Codex 2"]);
    for (const row of rows) expect(Object.keys(row)).not.toContain("label");
  });

  test("fetchedAt and ageMs come from the usage reading's own clock, both null when it was never read", () => {
    const fetchedAt = new Date(NOW - 5 * 60_000).toISOString();
    const read: UsageAccountSource = { provider: "claude", accountId: "c1", status: "active", usage: { lastFetchedAt: fetchedAt } };
    const neverRead: UsageAccountSource = { provider: "codex", accountId: "x1", status: "active", usage: {} };
    const rows = buildUsageSummary(NOW, [read, neverRead]).accounts;
    expect(rows[0]).toMatchObject({ fetchedAt, ageMs: 5 * 60_000 });
    expect(rows[1]).toMatchObject({ fetchedAt: null, ageMs: null });
  });

  test("an empty account list yields an empty, well-formed summary", () => {
    expect(buildUsageSummary(NOW, [])).toEqual({ now: new Date(NOW).toISOString(), accounts: [] });
  });
});
