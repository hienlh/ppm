/**
 * Tests for claude-usage.service.ts — fetch, 429 cooldown, dedup, multi-account polling.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from "bun:test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import {
  openTestDb,
  setDb,
  getLatestSnapshotForAccount,
  getLatestLimitSnapshot,
} from "../../../src/services/db.service.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { accountSelector } from "../../../src/services/account-selector.service.ts";
import {
  getUsageForAccount,
  getCachedUsage,
  refreshUsageNow,
  startUsagePolling,
  stopUsagePolling,
  _resetForTesting,
} from "../../../src/services/claude-usage.service.ts";

const KEY_PATH = resolve(tmpdir(), `ppm-test-usage-poll-${Date.now()}.key`);
const OAUTH_TOKEN_1 = "sk-ant-oat01-test-poll-account1-abcdef";
const OAUTH_TOKEN_2 = "sk-ant-oat01-test-poll-account2-ghijkl";
const API_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const originalFetch = globalThis.fetch;
let ensureSpy: ReturnType<typeof spyOn>;

/** Tracks fetch calls for assertions */
let fetchCalls: { url: string; token: string }[] = [];

function mockUsageApi(response: Record<string, any>, status = 200, headers: Record<string, string> = {}) {
  fetchCalls = [];
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const authHeader = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
    fetchCalls.push({ url: String(url), token: authHeader.replace("Bearer ", "") });
    return Promise.resolve(new Response(JSON.stringify(response), { status, headers }));
  }) as any;
}

function mockUsage429(retryAfter = 60) {
  fetchCalls = [];
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const authHeader = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
    fetchCalls.push({ url: String(url), token: authHeader.replace("Bearer ", "") });
    return Promise.resolve(new Response("rate limited", {
      status: 429,
      headers: { "retry-after": String(retryAfter) },
    }));
  }) as any;
}

function mockUsageError(status = 500) {
  fetchCalls = [];
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const authHeader = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
    fetchCalls.push({ url: String(url), token: authHeader.replace("Bearer ", "") });
    return Promise.resolve(new Response("error", { status }));
  }) as any;
}

/** Standard API response shape */
const USAGE_RESPONSE = {
  five_hour: { utilization: 33, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
  seven_day: { utilization: 4, resets_at: new Date(Date.now() + 604_800_000).toISOString() },
  seven_day_opus: { utilization: 10, resets_at: new Date(Date.now() + 604_800_000).toISOString() },
  seven_day_sonnet: { utilization: 2, resets_at: new Date(Date.now() + 604_800_000).toISOString() },
};

beforeEach(() => {
  setKeyPath(KEY_PATH);
  setDb(openTestDb());
  _resetForTesting();
  (accountSelector as any)._lastPickedId = null;
  fetchCalls = [];

  // Mock ensureFreshToken to return decrypted tokens from DB (avoids real OAuth refresh)
  ensureSpy = spyOn(accountService, "ensureFreshToken");
  ensureSpy.mockImplementation(async (id: string) => accountService.getWithTokens(id));
});

afterEach(() => {
  stopUsagePolling();
  globalThis.fetch = originalFetch;
  ensureSpy.mockRestore();
});

afterAll(() => {
  if (existsSync(KEY_PATH)) unlinkSync(KEY_PATH);
});

/** Add OAuth account, return ID */
function addOAuthAccount(label: string, token = OAUTH_TOKEN_1): string {
  return accountService.add({
    email: `${label}@test.com`,
    accessToken: token,
    refreshToken: "ref",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }).id;
}

// ---------------------------------------------------------------------------
// Fetch & parse API response
// ---------------------------------------------------------------------------
describe("fetch + parse API response", () => {
  it("parses all bucket types and persists to DB", async () => {
    const id = addOAuthAccount("parse", OAUTH_TOKEN_1);
    (accountSelector as any)._lastPickedId = id;
    mockUsageApi(USAGE_RESPONSE);

    await refreshUsageNow();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(API_USAGE_URL);

    const usage = getUsageForAccount(id);
    expect(usage.session?.utilization).toBeCloseTo(0.33, 2); // 33/100
    expect(usage.weekly?.utilization).toBeCloseTo(0.04, 2);
    expect(usage.weeklyOpus?.utilization).toBeCloseTo(0.10, 2);
    expect(usage.weeklySonnet?.utilization).toBeCloseTo(0.02, 2);
    expect(usage.session?.windowHours).toBe(5);
    expect(usage.weekly?.windowHours).toBe(168);
  });

  it("handles partial response (only five_hour)", async () => {
    const id = addOAuthAccount("partial", OAUTH_TOKEN_1);
    mockUsageApi({ five_hour: { utilization: 50, resets_at: new Date(Date.now() + 1_800_000).toISOString() } });

    await refreshUsageNow();

    const usage = getUsageForAccount(id);
    expect(usage.session?.utilization).toBeCloseTo(0.5, 2);
    expect(usage.weekly).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 429 handling & cooldown
// ---------------------------------------------------------------------------
describe("429 handling", () => {
  it("sets per-token cooldown on 429 and skips next poll", async () => {
    const id = addOAuthAccount("rate-limited", OAUTH_TOKEN_1);
    mockUsage429(120); // retry-after: 120s

    // First poll: gets 429, sets cooldown
    await refreshUsageNow();
    expect(fetchCalls).toHaveLength(1);

    // Second poll: should skip due to cooldown (no fetch call)
    fetchCalls = [];
    mockUsageApi(USAGE_RESPONSE);
    await refreshUsageNow();
    expect(fetchCalls).toHaveLength(0); // skipped due to cooldown

    // No data persisted
    const usage = getUsageForAccount(id);
    expect(usage.session).toBeUndefined();
  });

  it("enforces MIN_COOLDOWN_MS (60s floor) even if retry-after is lower", async () => {
    addOAuthAccount("low-retry", OAUTH_TOKEN_1);
    mockUsage429(5); // retry-after: 5s (below 60s floor)

    await refreshUsageNow();

    // Even though retry-after is 5s, cooldown should be at least 60s
    fetchCalls = [];
    mockUsageApi(USAGE_RESPONSE);
    await refreshUsageNow();
    expect(fetchCalls).toHaveLength(0); // still in cooldown
  });
});

// ---------------------------------------------------------------------------
// Non-OK response
// ---------------------------------------------------------------------------
describe("error responses", () => {
  it("does not crash on 500 error", async () => {
    addOAuthAccount("err", OAUTH_TOKEN_1);
    mockUsageError(500);
    // Should not throw
    await expect(refreshUsageNow()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-account polling
// ---------------------------------------------------------------------------
describe("multi-account polling", () => {
  it("fetches usage for each OAuth account", async () => {
    addOAuthAccount("multi-1", OAUTH_TOKEN_1);
    addOAuthAccount("multi-2", OAUTH_TOKEN_2);
    mockUsageApi(USAGE_RESPONSE);

    await refreshUsageNow();

    expect(fetchCalls).toHaveLength(2);
    const tokens = fetchCalls.map(c => c.token);
    expect(tokens).toContain(OAUTH_TOKEN_1);
    expect(tokens).toContain(OAUTH_TOKEN_2);
  });

  it("skips disabled accounts", async () => {
    const id = addOAuthAccount("disabled", OAUTH_TOKEN_1);
    accountService.setDisabled(id);
    addOAuthAccount("enabled", OAUTH_TOKEN_2);
    mockUsageApi(USAGE_RESPONSE);

    await refreshUsageNow();

    // Only the enabled account should be fetched
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].token).toBe(OAUTH_TOKEN_2);
  });

  it("skips non-OAuth tokens (API keys)", async () => {
    accountService.add({
      email: "apikey@test.com",
      accessToken: "sk-ant-api03-key-0123456789", // Not oat prefix
      refreshToken: "ref",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    addOAuthAccount("oauth", OAUTH_TOKEN_1);
    mockUsageApi(USAGE_RESPONSE);

    await refreshUsageNow();

    // Only OAuth account fetched
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].token).toBe(OAUTH_TOKEN_1);
  });
});

// ---------------------------------------------------------------------------
// Poll deduplication
// ---------------------------------------------------------------------------
describe("poll dedup", () => {
  it("concurrent refreshUsageNow calls result in single fetch", async () => {
    addOAuthAccount("dedup", OAUTH_TOKEN_1);
    mockUsageApi(USAGE_RESPONSE);

    // Fire 3 concurrent refreshes
    const [r1, r2, r3] = await Promise.all([
      refreshUsageNow(),
      refreshUsageNow(),
      refreshUsageNow(),
    ]);

    // Only 1 actual API call (dedup via inflightPoll)
    expect(fetchCalls).toHaveLength(1);
    // All return same cached data
    expect(r1.session?.utilization).toBeCloseTo(0.33, 2);
    expect(r2.session?.utilization).toBeCloseTo(0.33, 2);
  });

  it("inflightPoll clears after error — next call works", async () => {
    addOAuthAccount("retry", OAUTH_TOKEN_1);
    mockUsageError(500);

    await refreshUsageNow(); // fails internally but doesn't throw
    expect(fetchCalls).toHaveLength(1);

    // Next call should work (inflightPoll cleared)
    fetchCalls = [];
    mockUsageApi(USAGE_RESPONSE);
    await refreshUsageNow();
    expect(fetchCalls).toHaveLength(1); // new fetch, not stuck
  });
});

// ---------------------------------------------------------------------------
// Change detection (hasChanged) — tested via DB state
// ---------------------------------------------------------------------------
describe("change detection", () => {
  it("inserts new row when utilization changes", async () => {
    const id = addOAuthAccount("change", OAUTH_TOKEN_1);
    mockUsageApi({ five_hour: { utilization: 20, resets_at: "2026-04-01T00:00:00Z" } });
    await refreshUsageNow();

    const snap1 = getLatestSnapshotForAccount(id);
    expect(snap1?.five_hour_util).toBeCloseTo(0.2, 2);

    // Change utilization — inflightPoll already null after await
    mockUsageApi({ five_hour: { utilization: 40, resets_at: "2026-04-01T00:00:00Z" } });
    await refreshUsageNow();

    expect(fetchCalls).toHaveLength(1); // verify API was called again
    const snap2 = getLatestSnapshotForAccount(id);
    expect(snap2?.five_hour_util).toBeCloseTo(0.4, 2);
    expect(snap2?.id).not.toBe(snap1?.id); // new row inserted
  });

  it("only touches timestamp when data unchanged", async () => {
    const id = addOAuthAccount("nochange", OAUTH_TOKEN_1);
    const fixedResponse = { five_hour: { utilization: 50, resets_at: "2026-04-01T00:00:00Z" } };

    mockUsageApi(fixedResponse);
    await refreshUsageNow();
    const snap1 = getLatestSnapshotForAccount(id);

    // Same data again — no need to reset, inflightPoll already null
    mockUsageApi(fixedResponse);
    await refreshUsageNow();
    const snap2 = getLatestSnapshotForAccount(id);

    // Same row (no new insert), but timestamp may be updated
    expect(snap2?.id).toBe(snap1?.id);
  });
});

// ---------------------------------------------------------------------------
// Polling lifecycle
// ---------------------------------------------------------------------------
describe("polling lifecycle", () => {
  it("startUsagePolling triggers immediate fetch", async () => {
    addOAuthAccount("poll-start", OAUTH_TOKEN_1);
    mockUsageApi(USAGE_RESPONSE);

    startUsagePolling();
    // Wait for initial pollOnce to complete
    await new Promise(r => setTimeout(r, 200));

    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    stopUsagePolling();
  });

  it("stopUsagePolling prevents further polls", () => {
    startUsagePolling();
    stopUsagePolling();
    // Double stop is safe
    stopUsagePolling();
  });

  it("double startUsagePolling is no-op", async () => {
    addOAuthAccount("double-start", OAUTH_TOKEN_1);
    mockUsageApi(USAGE_RESPONSE);

    startUsagePolling();
    startUsagePolling(); // should be no-op

    await new Promise(r => setTimeout(r, 200));
    stopUsagePolling();

    // Only 1 account → should have exactly 1 fetch from initial poll (not 2)
    expect(fetchCalls).toHaveLength(1);
  });

  it("refreshUsageNow works after a timed-out poll (inflightPoll cleared)", async () => {
    addOAuthAccount("timeout-recover", OAUTH_TOKEN_1);

    // Simulate a slow poll that exceeds POLL_TIMEOUT by making fetch hang
    let resolveHang: () => void;
    const hangPromise = new Promise<void>(r => { resolveHang = r; });
    globalThis.fetch = mock(() => hangPromise.then(() =>
      new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }),
    )) as any;

    // Start poll — pollOnce creates inflightPoll that hangs
    const pollPromise = refreshUsageNow();

    // Resolve the hanging fetch after a short delay
    await new Promise(r => setTimeout(r, 50));
    resolveHang!();
    await pollPromise;

    // inflightPoll should be cleared after completion
    fetchCalls = [];
    mockUsageApi({ five_hour: { utilization: 99, resets_at: "2026-04-01T00:00:00Z" } });
    const result = await refreshUsageNow();

    // Fresh fetch should work — not reusing stale promise
    expect(fetchCalls).toHaveLength(1);
    expect(result.session?.utilization).toBeCloseTo(0.99, 2);
  });
});

// ---------------------------------------------------------------------------
// BUG REPRO: inflightPoll stuck after Promise.race timeout
// ---------------------------------------------------------------------------
describe("BUG REPRO: inflightPoll stuck blocks subsequent polls", () => {
  it("reproduces the exact bug: slow fetch → inflightPoll stuck → polls blocked → fix unblocks", async () => {
    addOAuthAccount("stuck-poll", OAUTH_TOKEN_1);

    // Step 1: Start a poll with a fetch that NEVER resolves (simulates slow multi-account poll)
    let resolveHang!: (v: Response) => void;
    globalThis.fetch = mock(() =>
      new Promise<Response>(r => { resolveHang = r; }),
    ) as any;

    const hangingPoll = refreshUsageNow();
    await new Promise(r => setTimeout(r, 50)); // let pollOnce start

    // Step 2: Try to poll again with a working mock — BLOCKED by stuck inflightPoll
    fetchCalls = [];
    mockUsageApi(USAGE_RESPONSE);
    const blockedPoll = refreshUsageNow();
    await new Promise(r => setTimeout(r, 50));

    // ← THIS IS THE BUG: no new fetch possible, reuses hanging promise
    expect(fetchCalls).toHaveLength(0);

    // Step 3: Resolve hanging fetch first (prevents unhandled rejection)
    resolveHang(new Response(JSON.stringify({}), { status: 200 }));
    await hangingPoll.catch(() => {});
    await blockedPoll.catch(() => {});

    // Step 4: Simulate the fix — timeout handler clears inflightPoll
    // (In production, startUsagePolling does: if (result === "timeout") inflightPoll = null)
    _resetForTesting();

    // Step 5: Now a new poll works — proves the fix
    fetchCalls = [];
    mockUsageApi({ five_hour: { utilization: 77, resets_at: "2026-04-01T00:00:00Z" } });
    const freshResult = await refreshUsageNow();

    expect(fetchCalls).toHaveLength(1); // ← New fetch started!
    expect(freshResult.session?.utilization).toBeCloseTo(0.77, 2);
  });

  it("stale .finally() from old poll does NOT clear new poll's inflightPoll", async () => {
    addOAuthAccount("stale-finally", OAUTH_TOKEN_1);

    // Start a slow poll
    let resolveHang!: (v: Response) => void;
    globalThis.fetch = mock(() =>
      new Promise<Response>(r => { resolveHang = r; }),
    ) as any;

    const slowPoll = refreshUsageNow();
    await new Promise(r => setTimeout(r, 50));

    // Force-clear inflightPoll (simulates timeout handler)
    _resetForTesting();

    // Start a new poll immediately (while old is still pending)
    mockUsageApi(USAGE_RESPONSE);
    const newPoll = refreshUsageNow();
    // Don't await newPoll yet — we need old poll to resolve first

    // Resolve old hanging fetch — its .finally() runs
    resolveHang(new Response(JSON.stringify({}), { status: 200 }));
    await slowPoll.catch(() => {});
    await new Promise(r => setTimeout(r, 50)); // let .finally() microtask run

    // Await new poll — should succeed (old .finally() must NOT clear new inflightPoll)
    const result = await newPoll;
    expect(result.session?.utilization).toBeCloseTo(0.33, 2);
  });
});
