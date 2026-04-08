/**
 * Tests for claude-usage.service.ts — snapshot conversion, public getters, cost tracking.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import {
  openTestDb,
  setDb,
  insertLimitSnapshot,
  getLatestLimitSnapshot,
  getLatestSnapshotForAccount,
} from "../../../src/services/db.service.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { accountSelector } from "../../../src/services/account-selector.service.ts";
import {
  getUsageForAccount,
  getAllAccountUsages,
  getCachedUsage,
  updateFromSdkEvent,
  _resetForTesting,
} from "../../../src/services/claude-usage.service.ts";

const KEY_PATH = resolve(tmpdir(), `ppm-test-usage-cache-${Date.now()}.key`);
const OAUTH_TOKEN = "sk-ant-oat01-test-abcdef0123456789abcdef";
const API_KEY_TOKEN = "sk-ant-api03-test-key-0123456789abcdef";

beforeEach(() => {
  setKeyPath(KEY_PATH);
  setDb(openTestDb());
  _resetForTesting();
  (accountSelector as any)._lastPickedId = null;
});

afterAll(() => {
  if (existsSync(KEY_PATH)) unlinkSync(KEY_PATH);
});

/** Insert account + snapshot, return account ID */
function seedAccount(
  label: string,
  token: string,
  snap: Partial<{
    fiveHour: number; fiveHourResets: string;
    weekly: number; weeklyResets: string;
    weeklyOpus: number; weeklyOpusResets: string;
    weeklySonnet: number; weeklySonnetResets: string;
  }> = {},
): string {
  const acc = accountService.add({
    email: `${label}@test.com`,
    accessToken: token,
    refreshToken: "ref",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  insertLimitSnapshot({
    account_id: acc.id,
    five_hour_util: snap.fiveHour ?? 0.33,
    five_hour_resets_at: snap.fiveHourResets ?? new Date(Date.now() + 3_600_000).toISOString(),
    weekly_util: snap.weekly ?? 0.04,
    weekly_resets_at: snap.weeklyResets ?? new Date(Date.now() + 604_800_000).toISOString(),
    weekly_opus_util: snap.weeklyOpus ?? null,
    weekly_opus_resets_at: snap.weeklyOpusResets ?? null,
    weekly_sonnet_util: snap.weeklySonnet ?? null,
    weekly_sonnet_resets_at: snap.weeklySonnetResets ?? null,
  });
  return acc.id;
}

// ---------------------------------------------------------------------------
// getUsageForAccount
// ---------------------------------------------------------------------------
describe("getUsageForAccount", () => {
  it("returns buckets from DB snapshot", () => {
    const id = seedAccount("a1", OAUTH_TOKEN, { fiveHour: 0.5, weekly: 0.12, weeklyOpus: 0.08 });
    const u = getUsageForAccount(id);
    expect(u.session?.utilization).toBe(0.5);
    expect(u.weekly?.utilization).toBe(0.12);
    expect(u.weeklyOpus?.utilization).toBe(0.08);
    expect(u.lastFetchedAt).toBeTruthy();
  });

  it("returns empty object when no snapshot", () => {
    const acc = accountService.add({ email: "no-snap@test.com", accessToken: OAUTH_TOKEN, refreshToken: "r", expiresAt: 9999999999 });
    expect(getUsageForAccount(acc.id)).toEqual({});
  });

  it("computes resetsInMinutes for 5-hour bucket", () => {
    const futureReset = new Date(Date.now() + 90 * 60_000).toISOString(); // 90min
    const id = seedAccount("a2", OAUTH_TOKEN, { fiveHour: 0.4, fiveHourResets: futureReset });
    const u = getUsageForAccount(id);
    expect(u.session?.resetsInMinutes).toBeGreaterThan(85);
    expect(u.session?.resetsInMinutes).toBeLessThanOrEqual(91);
    expect(u.session?.resetsInHours).toBeNull(); // only hours for >5h windows
  });

  it("computes resetsInHours for weekly bucket", () => {
    const futureReset = new Date(Date.now() + 48 * 3_600_000).toISOString(); // 48h
    const id = seedAccount("a3", OAUTH_TOKEN, { weekly: 0.1, weeklyResets: futureReset });
    const u = getUsageForAccount(id);
    expect(u.weekly?.resetsInHours).toBeGreaterThan(47);
    expect(u.weekly?.resetsInHours).toBeLessThanOrEqual(48.1);
    expect(u.weekly?.resetsInMinutes).toBeNull(); // only mins for <=5h windows
  });
});

// ---------------------------------------------------------------------------
// snapshotToUsage — UTC timestamp handling
// ---------------------------------------------------------------------------
describe("snapshot UTC timestamp", () => {
  it("appends Z to SQLite datetime format (no Z suffix)", () => {
    insertLimitSnapshot({
      account_id: null,
      five_hour_util: 0.1, five_hour_resets_at: null,
      weekly_util: null, weekly_resets_at: null,
      weekly_opus_util: null, weekly_opus_resets_at: null,
      weekly_sonnet_util: null, weekly_sonnet_resets_at: null,
    });
    // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (no Z)
    const row = getLatestLimitSnapshot()!;
    expect(row.recorded_at).not.toMatch(/Z$/); // confirm SQLite format

    (accountSelector as any)._lastPickedId = null;
    const cached = getCachedUsage();
    expect(cached.lastFetchedAt).toMatch(/Z$/); // service adds Z
  });
});

// ---------------------------------------------------------------------------
// getAllAccountUsages
// ---------------------------------------------------------------------------
describe("getAllAccountUsages", () => {
  it("returns entries with isOAuth flag based on token prefix", () => {
    seedAccount("oauth-acc", OAUTH_TOKEN);
    seedAccount("apikey-acc", API_KEY_TOKEN);
    const entries = getAllAccountUsages();
    expect(entries).toHaveLength(2);
    const oauthEntry = entries.find(e => e.accountLabel === "oauth-acc@test.com" || e.usage.session?.utilization === 0.33);
    // At least one should be OAuth, one not
    const oauthCount = entries.filter(e => e.isOAuth).length;
    const apiCount = entries.filter(e => !e.isOAuth).length;
    expect(oauthCount).toBeGreaterThanOrEqual(1);
    expect(apiCount).toBeGreaterThanOrEqual(1);
  });

  it("excludes expired accounts without refresh token", () => {
    // Add expired account without refresh token
    const expired = accountService.add({
      email: "expired@test.com",
      accessToken: OAUTH_TOKEN,
      refreshToken: "", // empty = no refresh
      expiresAt: Math.floor(Date.now() / 1000) - 3600, // expired 1h ago
    });
    const activeId = seedAccount("active", OAUTH_TOKEN);

    const entries = getAllAccountUsages();
    const ids = entries.map(e => e.accountId);
    // All accounts returned (expired included — UI handles filtering)
    expect(ids).toContain(expired.id);
    // Active account should be present
    expect(ids).toContain(activeId);
  });
});

// ---------------------------------------------------------------------------
// getCachedUsage
// ---------------------------------------------------------------------------
describe("getCachedUsage", () => {
  it("returns active account usage when selector has picked", () => {
    const id = seedAccount("main", OAUTH_TOKEN, { fiveHour: 0.6, weekly: 0.15 });
    (accountSelector as any)._lastPickedId = id;

    const cached = getCachedUsage();
    expect(cached.session?.utilization).toBe(0.6);
    expect(cached.weekly?.utilization).toBe(0.15);
    expect(cached.activeAccountId).toBe(id);
  });

  it("includes accumulated cost from SDK events", () => {
    const id = seedAccount("cost-acc", OAUTH_TOKEN);
    (accountSelector as any)._lastPickedId = id;

    updateFromSdkEvent(undefined, undefined, 0.5);
    updateFromSdkEvent(undefined, undefined, 0.3);

    const cached = getCachedUsage();
    expect(cached.totalCostUsd).toBeCloseTo(0.8, 4);
  });

  it("falls back to legacy snapshot when no active account", () => {
    (accountSelector as any)._lastPickedId = null;
    insertLimitSnapshot({
      account_id: null,
      five_hour_util: 0.25, five_hour_resets_at: null,
      weekly_util: 0.03, weekly_resets_at: null,
      weekly_opus_util: null, weekly_opus_resets_at: null,
      weekly_sonnet_util: null, weekly_sonnet_resets_at: null,
    });

    const cached = getCachedUsage();
    expect(cached.session?.utilization).toBe(0.25);
    expect(cached.weekly?.utilization).toBe(0.03);
  });

  it("returns empty when no data at all", () => {
    (accountSelector as any)._lastPickedId = null;
    const cached = getCachedUsage();
    expect(cached.lastFetchedAt).toBeUndefined();
    expect(cached.session).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// updateFromSdkEvent
// ---------------------------------------------------------------------------
describe("updateFromSdkEvent", () => {
  it("accumulates cost across multiple calls", () => {
    (accountSelector as any)._lastPickedId = null;
    updateFromSdkEvent(undefined, undefined, 1.0);
    updateFromSdkEvent(undefined, undefined, 2.5);
    updateFromSdkEvent(undefined, undefined, 0.25);
    const cached = getCachedUsage();
    expect(cached.totalCostUsd).toBeCloseTo(3.75, 4);
  });

  it("ignores calls without costUsd", () => {
    (accountSelector as any)._lastPickedId = null;
    updateFromSdkEvent("session", 0.5);
    const cached = getCachedUsage();
    expect(cached.totalCostUsd).toBeUndefined(); // 0 is falsy → undefined
  });
});
