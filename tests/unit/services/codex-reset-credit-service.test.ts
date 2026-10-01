/**
 * "Use reset" is gated on the server, against a live quota read: a reset is one-use and
 * moves the weekly reset date, so spending one before a limit is reached is pure loss.
 * Codex itself is faked here — the quota read and the consume call are the two doors out.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import type { UsageInfo } from "../../../src/types/chat.ts";
import {
  spendCodexResetCredit as spendWith, ResetCreditRefusedError, type ResetCreditCodexPorts,
} from "../../../src/services/codex-reset-credit.service.ts";
import { createCodexAccount, removeCodexAccount, listCodexAccounts } from "../../../src/services/codex-account.service.ts";
import {
  markCodexAccountUsageLimited, isCodexAccountUsageLimited, _resetCodexCooldownsForTesting,
} from "../../../src/services/codex-account-cooldown.ts";
import type { ResetCreditOutcome } from "../../../src/providers/codex-app-server/codex-reset-credit.ts";

let liveUsage: UsageInfo = {};
let liveError: Error | null = null;
const consumed: { home: string; key: string; creditId?: string }[] = [];
let outcome: ResetCreditOutcome = "reset";

/** Codex stand-in: the quota read, the consume call and the read back afterwards. */
const fakeCodex: ResetCreditCodexPorts = {
  readUsage: async () => { if (liveError) throw liveError; return liveUsage; },
  consume: async (home, key, creditId) => { consumed.push({ home, key, creditId }); return outcome; },
  // The third door. Without it the service read usage for real on the way out, which is a
  // network call in a test whose whole point is that Codex is faked.
  refresh: async () => liveUsage,
};
const spendCodexResetCredit = (id: string) => spendWith(id, fakeCodex);

const bucket = (utilization: number) => ({ utilization, resetsAt: "2026-10-04T02:20:16.000Z", resetsInMinutes: null, resetsInHours: 1, windowHours: 168 });
const mk = () => createCodexAccount({ label: "vanhoang", type: "chatgpt", dailyGuardEnabled: false });

async function refusal(id: string): Promise<{ status: number; message: string }> {
  try { await spendCodexResetCredit(id); } catch (e) {
    if (e instanceof ResetCreditRefusedError) return { status: e.status, message: e.message };
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("spending a Codex reset credit", () => {
  beforeEach(() => {
    for (const a of listCodexAccounts()) removeCodexAccount(a.id);
    _resetCodexCooldownsForTesting();
    consumed.length = 0;
    liveError = null;
    outcome = "reset";
  });

  it("refuses below a limit and never calls Codex's consume", async () => {
    const a = mk();
    liveUsage = { session: bucket(0.9), weekly: bucket(0.4), resetCredits: { available: 3, nextCreditId: "c1" } };
    const r = await refusal(a.id);
    expect(r.status).toBe(409);
    expect(r.message).toContain("has not reached a limit");
    expect(consumed).toEqual([]);
  });

  it("spends the soonest-expiring credit once a limit is reached, with a fresh idempotency key", async () => {
    const a = mk();
    liveUsage = { session: bucket(1), weekly: bucket(0.6), resetCredits: { available: 3, nextCreditId: "c-soonest" } };
    const res = await spendCodexResetCredit(a.id);
    expect(res.outcome).toBe("reset");
    expect(consumed).toHaveLength(1);
    expect(consumed[0]!.home).toBe(a.home);
    expect(consumed[0]!.creditId).toBe("c-soonest");
    expect(consumed[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("treats a quota refusal Codex already gave as a reached limit, and lifts the park on success", async () => {
    const a = mk();
    liveUsage = { weekly: bucket(0.97), resetCredits: { available: 1 } };
    markCodexAccountUsageLimited(a.id);
    await spendCodexResetCredit(a.id);
    expect(consumed).toHaveLength(1);
    expect(isCodexAccountUsageLimited(a.id)).toBe(false);
  });

  it("refuses with no credit left, when the quota cannot be read, and for an unknown account", async () => {
    const a = mk();
    liveUsage = { weekly: bucket(1), resetCredits: { available: 0 } };
    expect((await refusal(a.id)).message).toContain("no free reset left");
    liveError = new Error("401 Unauthorized");
    expect((await refusal(a.id)).status).toBe(502);
    expect((await refusal("no-such-account")).status).toBe(404);
    expect(consumed).toEqual([]);
  });

  it("does not let a double click become two attempts", async () => {
    const a = mk();
    liveUsage = { weekly: bucket(1), resetCredits: { available: 2 } };
    const [first, second] = await Promise.allSettled([spendCodexResetCredit(a.id), spendCodexResetCredit(a.id)]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(consumed).toHaveLength(1);
  });
});
