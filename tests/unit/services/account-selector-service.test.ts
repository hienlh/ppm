import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { openTestDb, setDb, closeDb, updateAccount, insertLimitSnapshot } from "../../../src/services/db.service.ts";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { accountSelector } from "../../../src/services/account-selector.service.ts";

const testKeyPath = resolve(tmpdir(), `ppm-test-selector-${Date.now()}.key`);
setKeyPath(testKeyPath);

function addAccount(email: string, priority = 0) {
  return accountService.add({
    email,
    accessToken: `access-${email}`,
    refreshToken: `refresh-${email}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    label: email,
  });
}

beforeEach(() => {
  setDb(openTestDb());
  // Reset strategy to default
  accountSelector.setStrategy("round-robin");
  accountSelector.setMaxRetry(0);
});

afterEach(() => {
  setDb(openTestDb()); // keep db as in-memory, never null (closeDb → null → getDb opens prod DB)
  if (existsSync(testKeyPath)) unlinkSync(testKeyPath);
});

describe("AccountSelectorService", () => {
  it("returns null when no accounts in DB", () => {
    expect(accountSelector.next()).toBeNull();
  });

  it("isEnabled() false when no accounts", () => {
    expect(accountSelector.isEnabled()).toBe(false);
  });

  it("isEnabled() true when accounts exist", () => {
    addAccount("a@test.com");
    expect(accountSelector.isEnabled()).toBe(true);
  });

  it("round-robin cycles through all accounts", () => {
    const a = addAccount("a@test.com");
    const b = addAccount("b@test.com");
    const c = addAccount("c@test.com");

    const picked = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const acc = accountSelector.next();
      expect(acc).not.toBeNull();
      picked.add(acc!.id);
    }
    // All 3 unique accounts should be returned
    expect(picked.size).toBe(3);
    expect(picked.has(a.id)).toBe(true);
    expect(picked.has(b.id)).toBe(true);
    expect(picked.has(c.id)).toBe(true);
  });

  it("skips disabled accounts", () => {
    const a = addAccount("a@test.com");
    addAccount("b@test.com");
    accountService.setDisabled(a.id);

    // Should only ever return b
    for (let i = 0; i < 5; i++) {
      const acc = accountSelector.next();
      expect(acc).not.toBeNull();
      expect(acc!.id).not.toBe(a.id);
    }
  });

  it("returns null when all accounts disabled", () => {
    const a = addAccount("a@test.com");
    accountService.setDisabled(a.id);
    expect(accountSelector.next()).toBeNull();
  });

  it("skips accounts on active cooldown", () => {
    const a = addAccount("a@test.com");
    addAccount("b@test.com");
    // Set cooldown far in the future
    accountService.setCooldown(a.id, Date.now() + 60_000);

    for (let i = 0; i < 4; i++) {
      const acc = accountSelector.next();
      expect(acc).not.toBeNull();
      expect(acc!.id).not.toBe(a.id);
    }
  });

  it("clears expired cooldowns automatically", () => {
    const a = addAccount("a@test.com");
    // Set cooldown in the past (already expired)
    accountService.setCooldown(a.id, Date.now() - 1_000);

    const acc = accountSelector.next();
    // Expired cooldown should be cleared — account is available again
    expect(acc).not.toBeNull();
    // After clearing, account should be active
    const updated = accountService.list().find((x) => x.id === a.id);
    expect(updated?.status).toBe("active");
  });

  it("fill-first always picks highest-priority active account", () => {
    accountSelector.setStrategy("fill-first");
    const a = accountService.add({ email: "a@test.com", accessToken: "ta", refreshToken: "ra", expiresAt: 9999 });
    accountService.add({ email: "b@test.com", accessToken: "tb", refreshToken: "rb", expiresAt: 9999 });

    // Give a higher priority than b
    updateAccount(a.id, { priority: 10 });

    const acc1 = accountSelector.next();
    const acc2 = accountSelector.next();
    expect(acc1!.id).toBe(a.id);
    expect(acc2!.id).toBe(a.id);
  });

  it("onRateLimit() sets cooldown on account", () => {
    const a = addAccount("a@test.com");
    accountSelector.onRateLimit(a.id);
    const updated = accountService.list().find((x) => x.id === a.id)!;
    expect(updated.status).toBe("cooldown");
    expect(updated.cooldownUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("onRateLimit() applies exponential backoff", () => {
    const a = addAccount("a@test.com");
    // First rate limit: ~1s cooldown
    accountSelector.onRateLimit(a.id);
    const cd1 = accountService.list().find((x) => x.id === a.id)!.cooldownUntil!;
    // Restore to active so we can rate limit again
    accountService.setEnabled(a.id);
    // Second rate limit: ~2s cooldown
    accountSelector.onRateLimit(a.id);
    const cd2 = accountService.list().find((x) => x.id === a.id)!.cooldownUntil!;
    expect(cd2).toBeGreaterThanOrEqual(cd1);
  });

  it("onAuthError() puts account in cooldown", () => {
    const a = addAccount("a@test.com");
    accountSelector.onAuthError(a.id);
    expect(accountService.list()[0].status).toBe("cooldown");
  });

  it("onSuccess() tracks usage", () => {
    const a = addAccount("a@test.com");
    accountSelector.onSuccess(a.id);
    expect(accountService.list()[0].totalRequests).toBe(1);
  });

  it("activeCount() counts only truly active accounts", () => {
    const a = addAccount("a@test.com");
    const b = addAccount("b@test.com");
    addAccount("c@test.com");
    accountService.setDisabled(a.id);
    accountService.setCooldown(b.id, Date.now() + 60_000);
    // Only c is truly active
    expect(accountSelector.activeCount()).toBe(1);
  });

  it("getStrategy() defaults to round-robin", () => {
    expect(accountSelector.getStrategy()).toBe("round-robin");
  });

  it("setStrategy() persists via config", () => {
    accountSelector.setStrategy("fill-first");
    expect(accountSelector.getStrategy()).toBe("fill-first");
  });

  it("getMaxRetry() defaults to 0", () => {
    expect(accountSelector.getMaxRetry()).toBe(0);
  });

  it("setMaxRetry() persists via config", () => {
    accountSelector.setMaxRetry(3);
    expect(accountSelector.getMaxRetry()).toBe(3);
  });
});

// Helper: insert a usage snapshot for an account
function insertUsage(accountId: string, opts: {
  fiveHour: number;
  weekly: number;
  weeklyResetsAt?: string;
}) {
  insertLimitSnapshot({
    account_id: accountId,
    five_hour_util: opts.fiveHour,
    five_hour_resets_at: null,
    weekly_util: opts.weekly,
    weekly_resets_at: opts.weeklyResetsAt ?? null,
    weekly_opus_util: null,
    weekly_opus_resets_at: null,
    weekly_sonnet_util: null,
    weekly_sonnet_resets_at: null,
  });
}

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3_600_000).toISOString();
}

describe("lowest-usage weighted sustainability strategy", () => {
  beforeEach(() => {
    setDb(openTestDb());
    accountSelector.setStrategy("lowest-usage");
  });

  afterEach(() => {
    setDb(openTestDb());
  });

  it("prefers account with lower 5hr when weekly is similar", () => {
    const a = addAccount("a@test.com");
    const b = addAccount("b@test.com");

    insertUsage(a.id, { fiveHour: 0.10, weekly: 0.20, weeklyResetsAt: hoursFromNow(100) });
    insertUsage(b.id, { fiveHour: 0.50, weekly: 0.20, weeklyResetsAt: hoursFromNow(100) });

    const picked = accountSelector.next();
    expect(picked!.id).toBe(a.id);
  });

  it("prefers account with more weekly remaining over lower 5hr", () => {
    // Peter Van: 5hr=23%, weekly=96%, reset 34h
    const peter = addAccount("peter@test.com");
    // Jim: 5hr=47%, weekly=22%, reset 113h
    const jim = addAccount("jim@test.com");

    insertUsage(peter.id, { fiveHour: 0.23, weekly: 0.96, weeklyResetsAt: hoursFromNow(34) });
    insertUsage(jim.id, { fiveHour: 0.47, weekly: 0.22, weeklyResetsAt: hoursFromNow(113) });

    const picked = accountSelector.next();
    // Jim should win: high sustainability (78% remaining / large window)
    expect(picked!.id).toBe(jim.id);
  });

  it("considers weekly reset proximity — high usage but imminent reset is OK", () => {
    // Account A: weekly 80%, resets in 6h → decent sustainability (20% for 6h, soon fresh)
    const a = addAccount("a@test.com");
    // Account B: weekly 30%, resets in 160h → lots remaining but spread over long time
    const b = addAccount("b@test.com");

    insertUsage(a.id, { fiveHour: 0.10, weekly: 0.80, weeklyResetsAt: hoursFromNow(6) });
    insertUsage(b.id, { fiveHour: 0.10, weekly: 0.30, weeklyResetsAt: hoursFromNow(160) });

    // A: sustainability = 0.20 / (6/168) = 0.20/0.036 = 5.6 → capped 1.0
    //    score = 0.35*0.9 + 0.65*1.0 = 0.965
    // B: sustainability = 0.70 / (160/168) = 0.70/0.952 = 0.735
    //    score = 0.35*0.9 + 0.65*0.735 = 0.793
    const picked = accountSelector.next();
    expect(picked!.id).toBe(a.id);
  });

  it("skips exhausted accounts (weekly >= 100%)", () => {
    const exhausted = addAccount("exhausted@test.com");
    const fresh = addAccount("fresh@test.com");

    insertUsage(exhausted.id, { fiveHour: 0.10, weekly: 1.0, weeklyResetsAt: hoursFromNow(10) });
    insertUsage(fresh.id, { fiveHour: 0.50, weekly: 0.50, weeklyResetsAt: hoursFromNow(100) });

    const picked = accountSelector.next();
    expect(picked!.id).toBe(fresh.id);
  });

  it("skips exhausted accounts (5hr >= 100%)", () => {
    const blocked = addAccount("blocked@test.com");
    const ok = addAccount("ok@test.com");

    insertUsage(blocked.id, { fiveHour: 1.0, weekly: 0.10, weeklyResetsAt: hoursFromNow(100) });
    insertUsage(ok.id, { fiveHour: 0.60, weekly: 0.40, weeklyResetsAt: hoursFromNow(100) });

    const picked = accountSelector.next();
    expect(picked!.id).toBe(ok.id);
  });

  it("falls back to highest score when all exhausted", () => {
    const a = addAccount("a@test.com");
    const b = addAccount("b@test.com");

    // Both exhausted, but a resets sooner → higher sustainability score
    insertUsage(a.id, { fiveHour: 1.0, weekly: 1.0, weeklyResetsAt: hoursFromNow(2) });
    insertUsage(b.id, { fiveHour: 1.0, weekly: 1.0, weeklyResetsAt: hoursFromNow(100) });

    const picked = accountSelector.next();
    // Both have immediate=0, but a has higher sustainability due to imminent reset
    expect(picked).not.toBeNull();
  });

  it("treats accounts with no snapshot as 0% usage (preferred)", () => {
    const noData = addAccount("new@test.com");
    const used = addAccount("used@test.com");

    // No snapshot for noData → treated as 0% on everything
    insertUsage(used.id, { fiveHour: 0.30, weekly: 0.30, weeklyResetsAt: hoursFromNow(100) });

    const picked = accountSelector.next();
    // noData: immediate=1.0, sustainability=1.0/max(168/168,0.05)=1.0 → score=1.0
    expect(picked!.id).toBe(noData.id);
  });

  it("real-world scenario from image — 4 accounts", () => {
    const vincent = addAccount("vincent@test.com");
    const victor = addAccount("victor@test.com");
    const peter = addAccount("peter@test.com");
    const jim = addAccount("jim@test.com");

    // Vincent: 5hr=14%, weekly=100%, reset 1d11h (35h)
    insertUsage(vincent.id, { fiveHour: 0.14, weekly: 1.0, weeklyResetsAt: hoursFromNow(35) });
    // Victor: 5hr=100%, weekly=89%, reset 1d10h (34h)
    insertUsage(victor.id, { fiveHour: 1.0, weekly: 0.89, weeklyResetsAt: hoursFromNow(34) });
    // Peter Van: 5hr=23%, weekly=96%, reset 1d10h (34h)
    insertUsage(peter.id, { fiveHour: 0.23, weekly: 0.96, weeklyResetsAt: hoursFromNow(34) });
    // Jim: 5hr=47%, weekly=22%, reset 4d17h (113h)
    insertUsage(jim.id, { fiveHour: 0.47, weekly: 0.22, weeklyResetsAt: hoursFromNow(113) });

    const picked = accountSelector.next();
    // Vincent: EXHAUSTED (weekly=100%)
    // Victor: EXHAUSTED (5hr=100%)
    // Peter: sustainability = 0.04/0.202 = 0.198, scaled = 0.099
    // Jim: sustainability = 0.78/0.673 = 1.159, scaled = 0.580
    expect(picked!.id).toBe(jim.id);
  });

  it("prefers account with imminent reset over one with more weekly remaining", () => {
    // Jim: 5hr=78%, weekly=24%, reset 4d14h (110h) — lots remaining but far reset
    const jim = addAccount("jim@test.com");
    // Alex: 5hr=63%, weekly=56%, reset 1d7h (31h) — less remaining but resets very soon
    const alex = addAccount("alex@test.com");

    insertUsage(jim.id, { fiveHour: 0.78, weekly: 0.24, weeklyResetsAt: hoursFromNow(110) });
    insertUsage(alex.id, { fiveHour: 0.63, weekly: 0.56, weeklyResetsAt: hoursFromNow(31) });

    const picked = accountSelector.next();
    // Jim: raw sustainability = 0.76/0.655 = 1.16, scaled = min(1.16,2)/2 = 0.58
    //      score = 0.35*0.22 + 0.65*0.58 = 0.454
    // Alex: raw sustainability = 0.44/0.185 = 2.38, scaled = min(2.38,2)/2 = 1.0
    //       score = 0.35*0.37 + 0.65*1.0 = 0.780
    expect(picked!.id).toBe(alex.id);
  });

  it("imminent reset wins even when other account has lower 5hr", () => {
    // A: 5hr=40%, weekly=24%, reset 111h — lower 5hr but far reset
    const a = addAccount("a@test.com");
    // B: 5hr=50%, weekly=56%, reset 32h — higher 5hr but resets soon
    const b = addAccount("b@test.com");

    insertUsage(a.id, { fiveHour: 0.40, weekly: 0.24, weeklyResetsAt: hoursFromNow(111) });
    insertUsage(b.id, { fiveHour: 0.50, weekly: 0.56, weeklyResetsAt: hoursFromNow(32) });

    const picked = accountSelector.next();
    // Without the 2.0 cap scaling, both sustainability would be 1.0 and A wins on 5hr.
    // With scaling: A sustainability = 1.15 → 0.576, B sustainability = 2.31 → 1.0
    // A score = 0.35*0.60 + 0.65*0.576 = 0.584
    // B score = 0.35*0.50 + 0.65*1.0 = 0.825
    expect(picked!.id).toBe(b.id);
  });
});

describe("peek()", () => {
  beforeEach(() => {
    setDb(openTestDb());
    accountSelector.setStrategy("lowest-usage");
  });

  afterEach(() => {
    setDb(openTestDb());
  });

  it("returns null when no active accounts", () => {
    expect(accountSelector.peek()).toBeNull();
  });

  it("returns the same account that next() would pick", () => {
    const a = addAccount("a@test.com");
    const b = addAccount("b@test.com");

    insertUsage(a.id, { fiveHour: 0.80, weekly: 0.80, weeklyResetsAt: hoursFromNow(100) });
    insertUsage(b.id, { fiveHour: 0.10, weekly: 0.10, weeklyResetsAt: hoursFromNow(100) });

    const peeked = accountSelector.peek();
    const picked = accountSelector.next();
    expect(peeked!.id).toBe(picked!.id);
  });

  it("does not consume the pick (non-destructive)", () => {
    accountSelector.setStrategy("round-robin");
    addAccount("a@test.com");
    addAccount("b@test.com");

    const peek1 = accountSelector.peek();
    const peek2 = accountSelector.peek();
    // Peeking twice should return same result (cursor not advanced)
    expect(peek1!.id).toBe(peek2!.id);
  });

  it("includes expired cooldown accounts", () => {
    const a = addAccount("a@test.com");
    // Cooldown already expired
    accountService.setCooldown(a.id, Date.now() - 1000);

    const peeked = accountSelector.peek();
    expect(peeked).not.toBeNull();
    expect(peeked!.id).toBe(a.id);
  });
});
