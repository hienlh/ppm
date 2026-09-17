/**
 * Binding a client-named account to a session.
 *
 * A chat tab claims an account when it opens and shows its name before anything is sent.
 * When the first message finally creates the session, the tab hands that id back so the
 * turn runs on the account the user was looking at rather than on whatever the strategy
 * would pick a moment later.
 *
 * The id arrives from a browser, so it is treated as a request rather than an instruction:
 * it is checked against the server's own pool and quietly declined if it does not hold up.
 * Declining is deliberately silent — the session is already created and the message is
 * about to be sent, and failing the whole request because a stale account id came along
 * would turn a cosmetic mismatch into a lost message. The turn simply routes normally.
 */

import { accountSelector } from "./account-selector.service.ts";
import { getCodexAccount } from "./codex-account.service.ts";
import { setSessionAccount, setSessionCodexAccount } from "./db.service.ts";

/** Whether this provider/account pair is one the server would route to on its own. */
export function canBindAccount(providerId: string, accountId: string): boolean {
  if (providerId === "codex") {
    const acc = getCodexAccount(accountId);
    return acc !== null && acc.status !== "disabled";
  }
  return accountSelector.canServe(accountId);
}

/**
 * Why a bind was refused, in words the panel can show as-is.
 *
 * Worth the extra call: "that account cannot serve this session" tells a user nothing they
 * can act on, while "it has reached its 5-hour limit, resets at 4:10pm" tells them whether
 * to wait or pick another.
 */
export function bindRefusalReason(providerId: string, accountId: string): string {
  if (providerId === "codex") {
    const acc = getCodexAccount(accountId);
    if (!acc) return "That account no longer exists.";
    return acc.status === "disabled" ? "That account is switched off." : "That account cannot serve this session.";
  }
  return accountSelector.refusalReason(accountId) ?? "That account cannot serve this session.";
}

/**
 * Bind a client-named account to a session, if the server agrees it can serve.
 *
 * Returns whether the binding was written, so a caller that can report back to a user
 * (the manual picker) can say the choice did not take, while a caller that cannot
 * (session creation) can ignore it.
 */
export function bindPickedAccount(sessionId: string, providerId: string, accountId: string): boolean {
  if (!canBindAccount(providerId, accountId)) return false;
  if (providerId === "codex") setSessionCodexAccount(sessionId, accountId);
  else setSessionAccount(sessionId, accountId);
  return true;
}
