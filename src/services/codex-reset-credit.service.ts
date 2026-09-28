/**
 * "Use reset" for a Codex account: spend one free rate-limit reset — but only once a limit has
 * actually been reached.
 *
 * The gate lives on the server, not just on the button. A reset is one-use, it moves the
 * weekly reset date (OpenAI: the next weekly reset is counted from when you continue, and the
 * original one is not also granted), and spending it early throws away whatever was left of
 * the window. So the decision is made against a *live* quota read taken right here, never
 * against whatever the card was last shown.
 */
import { randomUUID } from "node:crypto";
import { getCodexAccount } from "./codex-account.service.ts";
import { clearCodexAccountUsageLimit, isCodexAccountUsageLimited } from "./codex-account-cooldown.ts";
import { refreshUsage } from "./provider-usage/usage-registry.ts";
import { fetchCodexUsageLive } from "../providers/codex-app-server/codex-usage-fetch.ts";
import { consumeCodexResetCredit, type ResetCreditOutcome } from "../providers/codex-app-server/codex-reset-credit.ts";
import { usageLimitReached } from "../shared/usage-extra.ts";
import type { UsageInfo } from "../types/chat.ts";

/** A refusal the caller should show as-is, with the HTTP status that fits it. */
export class ResetCreditRefusedError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 502) { super(message); }
}

/** Accounts with a reset in flight — a double click must not become two attempts. */
const inFlight = new Set<string>();

export interface ResetCreditResult {
  outcome: ResetCreditOutcome;
  /** The account's quota after the attempt, freshly read. */
  usage: UsageInfo;
}

/** The two ways out to Codex, replaceable so a test can stand in for the app-server. */
export interface ResetCreditCodexPorts {
  readUsage: (codexHome: string) => Promise<UsageInfo>;
  consume: (codexHome: string, idempotencyKey: string, creditId?: string) => Promise<ResetCreditOutcome>;
}

const LIVE_PORTS: ResetCreditCodexPorts = { readUsage: fetchCodexUsageLive, consume: consumeCodexResetCredit };

export async function spendCodexResetCredit(accountId: string, ports: ResetCreditCodexPorts = LIVE_PORTS): Promise<ResetCreditResult> {
  const account = getCodexAccount(accountId);
  if (!account) throw new ResetCreditRefusedError("Account not found", 404);
  if (inFlight.has(accountId)) throw new ResetCreditRefusedError("A reset for this account is already in progress.", 409);
  inFlight.add(accountId);
  try {
    let live: UsageInfo;
    try {
      live = await ports.readUsage(account.home);
    } catch (e) {
      // Refuse rather than guess: the only safe answer to "is the limit reached?" is a fresh one.
      throw new ResetCreditRefusedError(`Could not read ${account.label}'s current usage, so no reset was used: ${(e as Error).message}`, 502);
    }
    // Codex refusing a turn for quota is also a reached limit, even if the figures lag it.
    if (!usageLimitReached(live) && !isCodexAccountUsageLimited(accountId)) {
      throw new ResetCreditRefusedError(`${account.label} has not reached a limit yet, so a reset would waste the usage left and move the weekly reset date. It is kept for when you hit the limit.`, 409);
    }
    if ((live.resetCredits?.available ?? 0) === 0) {
      throw new ResetCreditRefusedError(`${account.label} has no free reset left.`, 409);
    }
    // The soonest-expiring credit first: the others outlive it.
    const outcome = await ports.consume(account.home, randomUUID(), live.resetCredits?.nextCreditId);
    if (outcome === "reset") clearCodexAccountUsageLimit(accountId);
    console.log(`[codex] account ${accountId} reset credit → ${outcome}`);
    return { outcome, usage: await refreshUsage("codex", accountId) };
  } finally {
    inFlight.delete(accountId);
  }
}
