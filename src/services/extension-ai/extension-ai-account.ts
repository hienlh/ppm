/**
 * Which account answers an extension's one-shot call. Never through the chat router's own
 * pick: Claude's `next()` advances the round-robin cursor that chats rotate on, and in
 * round-robin `peek()` always names the same account; Codex round-robin moves `rrIndex`. An
 * extension calling often would then shift which account the person's next chat lands on.
 *
 * So: the named account when it can serve now, else the usable account with the lowest
 * 5-hour use in the usage store (Claude), or `selectCodexAccount` in `lowest-usage` mode,
 * which touches no cursor (Codex). With no accounts set up at all the provider's own sign-in
 * answers (`accountId` undefined). Accounts set up but none usable is `NO_ACCOUNT`.
 */
import { OneShotError } from "../../providers/one-shot-error.ts";
import { accountService } from "../account.service.ts";
import { accountSelector } from "../account-selector.service.ts";
import { getLatestSnapshotForAccount } from "../db.service.ts";
import { codexUsageLevel, getCodexAccount, listCodexAccounts, selectCodexAccount } from "../codex-account.service.ts";
import { isCodexAccountAuthFailed } from "../codex-account-auth-state.ts";
import { isCodexAccountUsageLimited } from "../codex-account-cooldown.ts";
import { getUsage } from "../provider-usage/usage-registry.ts";
import type { AiProviderId } from "./extension-ai-request.ts";

export interface PickedAccount {
  accountId?: string;
}

function noAccount(provider: string): OneShotError {
  return new OneShotError("NO_ACCOUNT", `No ${provider} account can take a request right now`);
}

function pickClaude(explicit: string | undefined): PickedAccount {
  if (explicit) {
    const named = accountService.list().find((a) => a.id === explicit);
    if (!named || named.status === "disabled") {
      throw new OneShotError("BAD_REQUEST", "accountId does not name an active Claude account");
    }
    if (accountSelector.canServe(explicit)) return { accountId: explicit };
  }
  if (!accountSelector.isEnabled()) return {};
  const fiveHour = (id: string) => getLatestSnapshotForAccount(id)?.five_hour_util ?? 0;
  const weekly = (id: string) => getLatestSnapshotForAccount(id)?.weekly_util ?? 0;
  const usable = accountService.list()
    .filter((a) => accountSelector.canServe(a.id))
    .sort((a, b) => fiveHour(a.id) - fiveHour(b.id) || weekly(a.id) - weekly(b.id) || a.createdAt - b.createdAt);
  if (usable.length === 0) throw noAccount("Claude");
  return { accountId: usable[0]!.id };
}

function pickCodex(explicit: string | undefined): PickedAccount {
  if (explicit) {
    const named = getCodexAccount(explicit);
    if (!named || named.status === "disabled") {
      throw new OneShotError("BAD_REQUEST", "accountId does not name an active Codex account");
    }
    if (!isCodexAccountAuthFailed(explicit) && !isCodexAccountUsageLimited(explicit)) return { accountId: explicit };
  }
  if (listCodexAccounts().length === 0) return {};
  const picked = selectCodexAccount({
    strategy: "lowest-usage",
    usageOf: (id) => codexUsageLevel(getUsage("codex", id)),
  });
  if (!picked) throw noAccount("Codex");
  return { accountId: picked.id };
}

/** The account a call runs on. Throws `NO_ACCOUNT`, or `BAD_REQUEST` for a bad `accountId`. */
export function pickOneShotAccount(provider: AiProviderId, explicit?: string): PickedAccount {
  return provider === "claude" ? pickClaude(explicit) : pickCodex(explicit);
}
