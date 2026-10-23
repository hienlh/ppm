/**
 * What a Codex one-shot learns about the account it ran on, recorded the way a chat records it.
 *
 * A signed-out login is recognised on codex's FIRST retry notice — the notice already names the
 * 401 in `additionalDetails` — and the account is benched, so the call fails in milliseconds
 * instead of sitting through codex's ~24 s reconnect loop, and the next call picks another
 * account. A usage-limit refusal parks the account until the reset it names. An answered turn
 * clears a sign-out mark, as a completed chat turn does.
 */
import { codexErrorMessage, isCodexUsageLimit, parseCodexUsageLimitReset } from "./codex-usage-limit.ts";
import { codexErrorText, codexSignedOutMessage, isCodexAuthFailure } from "./codex-auth-failure.ts";
import { redactTruncate } from "./codex-redact.ts";
import { clearCodexAccountAuthFailure, markCodexAccountAuthFailed } from "../../services/codex-account-auth-state.ts";
import { markCodexAccountUsageLimited } from "../../services/codex-account-cooldown.ts";
import { OneShotError, type OneShotUsage } from "../one-shot-error.ts";

export interface CodexAccountProblem {
  kind: "auth" | "usage";
  /** The unredacted cause, for the reset time; redacted before it is stored or shown. */
  reason: string;
}

/** The account problem an `error` notification names, retry notices included; null if none. */
export function codexAccountProblemOf(params: unknown): CodexAccountProblem | null {
  const authText = codexErrorText(params);
  if (isCodexAuthFailure(authText)) return { kind: "auth", reason: authText };
  const reason = codexErrorMessage(params);
  return isCodexUsageLimit(reason) ? { kind: "usage", reason } : null;
}

/** Bench a signed-out account, park a spent one. Nothing to record for the ambient login. */
export function recordCodexAccountProblem(accountId: string | undefined, problem: CodexAccountProblem): void {
  if (!accountId) return;
  if (problem.kind === "auth") markCodexAccountAuthFailed(accountId, redactTruncate(problem.reason, 256));
  else markCodexAccountUsageLimited(accountId, parseCodexUsageLimitReset(problem.reason)?.atMs);
}

/** An answered turn is proof the login works, whatever was observed before. */
export function recordCodexAccountAnswered(accountId: string | undefined): void {
  if (accountId) clearCodexAccountAuthFailure(accountId);
}

/** The error a call ends with when its account cannot answer. */
export function codexAccountProblemError(problem: CodexAccountProblem, usage: OneShotUsage): OneShotError {
  return problem.kind === "auth"
    ? new OneShotError("NO_ACCOUNT", codexSignedOutMessage(), { usage })
    : new OneShotError("RATE_LIMITED", `Codex did not answer: ${redactTruncate(problem.reason, 300)}`, { usage });
}
