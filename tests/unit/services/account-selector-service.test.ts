import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { openTestDb, setDb, closeDb, updateAccount } from "../../../src/services/db.service.ts";
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
  closeDb();
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

  it("onAuthError() disables account", () => {
    const a = addAccount("a@test.com");
    accountSelector.onAuthError(a.id);
    expect(accountService.list()[0].status).toBe("disabled");
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
