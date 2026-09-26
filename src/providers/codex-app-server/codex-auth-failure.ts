/**
 * Recognising a Codex account that is no longer signed in.
 *
 * A revoked or expired ChatGPT login does not stop the app-server from starting or
 * from opening a thread — both succeed. It is the model request that fails, and codex
 * then spends ~24s in its own reconnect loop ("Reconnecting... 1/5" twice over) before
 * it gives up. Each of those notices carries the real cause in `additionalDetails`
 * (`workspace routing discovery unauthorized (401)`), so the first one is already
 * enough to know that waiting will not help.
 *
 * The same account's quota read fails with `401 Unauthorized ... "code": "token_revoked"`,
 * which is the other place this is recognised.
 *
 * Narrow on purpose, like the usage-limit patterns: a false positive takes a working
 * account out of rotation. A bare "401" is not enough — it has to come with the word
 * the status means, or with codex's own sign-in wording.
 */

const AUTH_FAILURE_PATTERNS = [
  /\b401\b[^\n]{0,40}unauthori[sz]ed/i,
  /unauthori[sz]ed[^\n]{0,40}\b401\b/i,
  /\btoken_revoked\b/i,
  /invalidated\s+oauth\s+token/i,
  /refresh\s+token\s+(?:was|has\s+been)\s+(?:revoked|invalidated|already\s+used)/i,
  /(?:log|sign)\s+(?:out\s+and\s+sign\s+)?in\s+again/i,
];

/** Whether this error text means the account has to be signed in again. */
export function isCodexAuthFailure(message: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(message));
}

/**
 * Everything a codex `error` notification says about its cause, as one string.
 *
 * The headline of a retry notice is just "Reconnecting... 2/5"; the reason sits in
 * `additionalDetails`, so matching the message alone would never see it.
 */
export function codexErrorText(params: unknown): string {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const err = (p.error && typeof p.error === "object" ? p.error : {}) as Record<string, unknown>;
  return [err.message, err.additionalDetails, p.message]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" — ");
}

/** The message shown when a turn cannot run because its account is signed out. */
export function codexSignedOutMessage(accountLabel?: string | null): string {
  const who = accountLabel ? `Codex account ${accountLabel}` : "The Codex account";
  return `${who} is signed out (its login was revoked or expired). Press "Sign in again" on its card in Settings → Accounts → Codex.`;
}
