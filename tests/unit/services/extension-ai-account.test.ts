import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { getConfigValue, insertLimitSnapshot, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { accountSelector } from "../../../src/services/account-selector.service.ts";
import { createCodexAccount, listCodexAccounts, removeCodexAccount, selectCodexAccount, setCodexAccountStatus } from "../../../src/services/codex-account.service.ts";
import { setCachedUsage, _clearUsageCache } from "../../../src/services/provider-usage/usage-memory-cache.ts";
import { _resetCodexCooldownsForTesting, markCodexAccountUsageLimited } from "../../../src/services/codex-account-cooldown.ts";
import { _resetCodexAuthFailuresForTesting, markCodexAccountAuthFailed } from "../../../src/services/codex-account-auth-state.ts";
import { pickOneShotAccount } from "../../../src/services/extension-ai/extension-ai-account.ts";

const keyPath = resolve(tmpdir(), `ppm-test-ext-ai-account-${Date.now()}.key`);
setKeyPath(keyPath);

function addClaude(email: string) {
  return accountService.add({
    email, accessToken: `a-${email}`, refreshToken: `r-${email}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600, label: email,
  });
}

function usage(accountId: string, fiveHour: number, weekly = 0.1) {
  insertLimitSnapshot({
    account_id: accountId, five_hour_util: fiveHour, five_hour_resets_at: null, weekly_util: weekly,
    weekly_resets_at: null, weekly_opus_util: null, weekly_opus_resets_at: null,
    weekly_sonnet_util: null, weekly_sonnet_resets_at: null,
  });
}

const addCodex = (label: string, dailyGuardEnabled = false) => createCodexAccount({
  label, type: "apiKey", creds: { type: "apiKey", apiKey: `k-${label}` }, dailyGuardEnabled,
});

const codeOf = (p: Promise<unknown>) => p.then(() => "none", (e) => (e as { code?: string }).code);

/** A weekly-only bucket used up past what the daily guard allows on any weekday. */
const guardReached = () => ({
  weekly: {
    utilization: 1, windowHours: 168, resetsInMinutes: null, resetsInHours: null,
    resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  },
});

beforeEach(() => {
  for (const a of listCodexAccounts()) removeCodexAccount(a.id);
  setDb(openTestDb());
  accountSelector.setStrategy("round-robin");
  _clearUsageCache();
  _resetCodexCooldownsForTesting();
  _resetCodexAuthFailuresForTesting();
});

afterEach(() => {
  setDb(openTestDb());
  if (existsSync(keyPath)) unlinkSync(keyPath);
});

describe("pickOneShotAccount — Claude", () => {
  it("uses the provider's own sign-in when no account is set up", async () => {
    expect(await pickOneShotAccount("claude")).toEqual({});
  });

  it("uses a named account that can serve", async () => {
    const a = addClaude("a@x"); const b = addClaude("b@x");
    usage(a.id, 0.1); usage(b.id, 0.8);
    expect(await pickOneShotAccount("claude", b.id)).toEqual({ accountId: b.id });
  });

  it("picks the lowest 5-hour use and leaves the round-robin cursor where it was", async () => {
    const a = addClaude("a@x"); const b = addClaude("b@x"); const c = addClaude("c@x");
    usage(a.id, 0.7); usage(b.id, 0.2); usage(c.id, 0.5);
    const cursorBefore = getConfigValue("account_round_robin_last");
    for (let i = 0; i < 3; i++) expect(await pickOneShotAccount("claude")).toEqual({ accountId: b.id });
    expect(getConfigValue("account_round_robin_last")).toBe(cursorBefore);
    // A named account that has reached its cap falls back to the lowest-use pick.
    usage(a.id, 1.0);
    expect(await pickOneShotAccount("claude", a.id)).toEqual({ accountId: b.id });
  });

  it("refuses an unknown or disabled named account, and says NO_ACCOUNT when none can serve", async () => {
    const a = addClaude("a@x");
    expect(await codeOf(pickOneShotAccount("claude", "nope"))).toBe("BAD_REQUEST");
    accountService.setDisabled(a.id);
    expect(await codeOf(pickOneShotAccount("claude", a.id))).toBe("BAD_REQUEST");
    expect(await codeOf(pickOneShotAccount("claude"))).toBe("NO_ACCOUNT");
  });
});

describe("pickOneShotAccount — Codex", () => {
  it("uses the machine's own login when no Codex account exists", async () => {
    expect(await pickOneShotAccount("codex")).toEqual({});
  });

  it("picks the least-used account and does not move the round-robin index", async () => {
    const a = addCodex("A"); const b = addCodex("B");
    setCachedUsage("codex", a.id, { fiveHour: 0.6 });
    setCachedUsage("codex", b.id, { fiveHour: 0.1 });
    const first = selectCodexAccount({ strategy: "round-robin" })!.id;
    // One pick in between: had it advanced the index, the next round-robin pick would repeat.
    expect(await pickOneShotAccount("codex")).toEqual({ accountId: b.id });
    const second = selectCodexAccount({ strategy: "round-robin" })!.id;
    expect(second).not.toBe(first);
    expect(await pickOneShotAccount("codex", a.id)).toEqual({ accountId: a.id });
  });

  it("refuses a disabled named account and reports NO_ACCOUNT when every account is off", async () => {
    const a = addCodex("A");
    setCodexAccountStatus(a.id, "disabled");
    expect(await codeOf(pickOneShotAccount("codex", a.id))).toBe("BAD_REQUEST");
    expect(await codeOf(pickOneShotAccount("codex"))).toBe("NO_ACCOUNT");
  });

  it("never hands back an account parked for a spent quota, even the last one", async () => {
    const a = addCodex("A");
    markCodexAccountUsageLimited(a.id);
    expect(await codeOf(pickOneShotAccount("codex"))).toBe("NO_ACCOUNT");
    expect(await codeOf(pickOneShotAccount("codex", a.id))).toBe("NO_ACCOUNT");
    const b = addCodex("B");
    markCodexAccountUsageLimited(b.id);
    expect(await codeOf(pickOneShotAccount("codex"))).toBe("NO_ACCOUNT");
  });

  it("does not fall back to the machine's login when every account is signed out", async () => {
    const a = addCodex("A");
    markCodexAccountAuthFailed(a.id, "401 Unauthorized");
    expect(await codeOf(pickOneShotAccount("codex"))).toBe("NO_ACCOUNT");
  });

  it("keeps away from an account whose daily guard is reached", async () => {
    const guarded = addCodex("G", true);
    const open = addCodex("O");
    setCachedUsage("codex", guarded.id, { ...guardReached(), fiveHour: 0.01 });
    setCachedUsage("codex", open.id, { fiveHour: 0.9, sevenDay: 0.9 });
    expect(await pickOneShotAccount("codex")).toEqual({ accountId: open.id });
    expect(await pickOneShotAccount("codex", guarded.id)).toEqual({ accountId: open.id });
    markCodexAccountUsageLimited(open.id);
    expect(await codeOf(pickOneShotAccount("codex"))).toBe("NO_ACCOUNT");
  });
});
