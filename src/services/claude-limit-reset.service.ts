/**
 * "Reset for free" for a Claude account: spend one of the free limit resets Anthropic grants
 * (claude.ai's "Limit resets", Claude Code's `/limit-reset`).
 *
 * As with Codex's reset (`codex-reset-credit.service.ts`) the decision is made against a *live*
 * read taken right here, never against the card the user clicked: a grant the stored snapshot
 * calls usable may have been spent from claude.ai since, or be blocked by a limit reached
 * since. Unlike Codex's, a Claude reset does not move the weekly reset day, and some grants are
 * usable before any limit is reached — Anthropic says which (`usable_now`), and the browser's
 * confirmation says what is still left to lose.
 *
 * The claim goes out as Claude Code's CLI, like the read (`claude-cli-identity.ts`), with a
 * fresh `request_id` per attempt: Anthropic dedups on it, so one click is one reset however
 * the request is retried on the way.
 */
import { randomUUID } from "node:crypto";
import { accountService } from "./account.service.ts";
import { claudeCliHeaders } from "./claude-cli-identity.ts";
import { fetchClaudeAccountUsage, refreshUsageForAccount, type ClaudeUsage } from "./claude-usage.service.ts";
import {
  CLAUDE_RESET_GRANT_ID,
  claudeResetBlockedReason,
  claudeResetKindName,
  type ClaudeResetKind,
  type ClaudeResetResult,
} from "../shared/claude-limit-resets.ts";

/** A refusal the caller should show as-is, with the HTTP status that fits it. */
export class LimitResetRefusedError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502) { super(message); }
}

/** Accounts with a claim in flight — a double click must not become two attempts. */
const inFlight = new Set<string>();

/** Claude Code waits this long for a claim. */
const CLAIM_TIMEOUT_MS = 25_000;

export interface ClaimAnswer {
  result: ClaudeResetResult;
  reason?: string | null;
  resetsLeft?: number | null;
  weeklyResetsAt?: string | null;
}

export interface LimitResetResult extends ClaimAnswer {
  kind: ClaudeResetKind;
  /** The account's usage after the attempt, freshly read. */
  usage: ClaudeUsage;
}

/** The ways out to Anthropic, replaceable so a test never reaches a real account. */
export interface LimitResetPorts {
  token: (accountId: string) => Promise<string | null>;
  /** Organization the account belongs to — the claim is made on it. */
  organization: (accountId: string, token: string) => Promise<string | null>;
  readUsage: (accountId: string) => Promise<ClaudeUsage>;
  claim: (token: string, organizationUuid: string, grantId: string, requestId: string) => Promise<ClaimAnswer>;
  refresh: (accountId: string) => Promise<ClaudeUsage>;
}

const CLAIM_RESULTS = new Set(["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"]);

/** `POST /api/organizations/:org/reset_rate_limits`, read as Claude Code reads it. */
export async function claimClaudeLimitReset(token: string, organizationUuid: string, grantId: string, requestId: string): Promise<ClaimAnswer> {
  let res: Response;
  try {
    res = await fetch(`https://api.anthropic.com/api/organizations/${encodeURIComponent(organizationUuid)}/reset_rate_limits`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        ...claudeCliHeaders(),
      },
      body: JSON.stringify({ program: "cedar_ember", grant_id: grantId, request_id: requestId }),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
  } catch {
    // Sent, maybe applied, never answered: say so rather than "nothing was used".
    return { result: "error" };
  }
  if (res.status === 429) return { result: "rate_limited" };
  if (res.status === 401 || res.status === 403) return { result: "auth_error" };
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) return { result: "error" };
  const result = typeof body.result === "string" && CLAIM_RESULTS.has(body.result) ? body.result as ClaudeResetResult : "unavailable";
  return {
    result,
    reason: typeof body.reason === "string" ? body.reason : null,
    resetsLeft: typeof body.resets_left === "number" ? body.resets_left : null,
    weeklyResetsAt: typeof body.weekly_resets_at === "string" ? body.weekly_resets_at : null,
  };
}

const LIVE_PORTS: LimitResetPorts = {
  token: async (accountId) => (await accountService.ensureFreshToken(accountId))?.accessToken ?? null,
  organization: async (accountId, token) => {
    const stored = accountService.list().find((a) => a.id === accountId)?.profileData?.organization?.uuid;
    return stored ?? (await accountService.fetchOAuthProfile(token))?.organization?.uuid ?? null;
  },
  readUsage: fetchClaudeAccountUsage,
  claim: claimClaudeLimitReset,
  refresh: refreshUsageForAccount,
};

export async function spendClaudeLimitReset(accountId: string, grantId: unknown, ports: LimitResetPorts = LIVE_PORTS): Promise<LimitResetResult> {
  if (typeof grantId !== "string" || !CLAUDE_RESET_GRANT_ID.test(grantId)) throw new LimitResetRefusedError("Which reset to use is missing.", 400);
  const account = accountService.list().find((a) => a.id === accountId);
  if (!account) throw new LimitResetRefusedError("Account not found", 404);
  const name = account.label ?? account.email ?? accountId.slice(0, 8);
  if (inFlight.has(accountId)) throw new LimitResetRefusedError("A reset for this account is already in progress.", 409);
  inFlight.add(accountId);
  try {
    const token = await ports.token(accountId);
    if (!token?.startsWith("sk-ant-oat")) {
      throw new LimitResetRefusedError(`${name} is not signed in to a Claude subscription, so it has no limit resets.`, 409);
    }
    let live: ClaudeUsage;
    try {
      live = await ports.readUsage(accountId);
    } catch (e) {
      throw new LimitResetRefusedError(`Could not read ${name}'s limit resets, so none was used: ${(e as Error).message}`, 502);
    }
    const resets = live.limitResets;
    const grant = resets?.grants.find((g) => g.id === grantId);
    if (!resets || !grant) {
      await ports.refresh(accountId).catch(() => {});
      throw new LimitResetRefusedError(`${name} no longer has that reset. The list has been refreshed.`, 409);
    }
    const blocked = claudeResetBlockedReason(grant, resets);
    if (blocked) throw new LimitResetRefusedError(`${name}'s ${claudeResetKindName(grant.kind)} ${blocked}. Nothing was used.`, 409);

    const organization = await ports.organization(accountId, token);
    if (!organization) throw new LimitResetRefusedError(`Could not tell which organization ${name} belongs to, so no reset was used. Sign in to it again.`, 409);

    const answer = await ports.claim(token, organization, grant.id, randomUUID());
    console.log(`[claude] account ${accountId} limit reset ${grant.id} → ${answer.result}${answer.reason ? ` (${answer.reason})` : ""}`);
    // The selector parked this account until the limit reset; it just did.
    if (answer.result === "reset" && account.status === "cooldown") accountService.setEnabled(accountId);
    const usage = await ports.refresh(accountId).catch(() => live);
    return { ...answer, weeklyResetsAt: answer.weeklyResetsAt ?? resets.weeklyResetsAt ?? null, kind: grant.kind, usage };
  } finally {
    inFlight.delete(accountId);
  }
}
