import { accountSelector } from "./account-selector.service.ts";
import { getAllCodexUsages, codexUsageLevel, listCodexAccounts, selectCodexAccount } from "./codex-account.service.ts";
import { settleWithinBudget } from "./chat-prepare/settle-within-budget.ts";

export interface PickedAccount {
  id: string;
  label: string | null;
}

/**
 * Claim the Claude account that will serve a new chat tab. Synchronous: round-robin has no
 * async step, unlike Codex below.
 */
export function pickClaudeAccount(): PickedAccount | null {
  const picked = accountSelector.next();
  if (!picked) return null;
  return { id: picked.id, label: picked.label ?? picked.email ?? null };
}

export interface CodexPickOptions {
  /**
   * Budget for the usage fetch that feeds selection — not for selection itself. Left
   * undefined, the pick never times out: the behaviour `/api/codex-accounts/pick` has
   * always had, and the one `/chat/prepare` must not change for it.
   */
  usageBudgetMs?: number;
}

/**
 * Claim the Codex account that will serve a new chat tab.
 *
 * The budget wraps only the usage fetch that feeds the five-hour skip and lowest-usage
 * strategy. If it overruns, selection is skipped outright: nothing is consumed and the
 * round-robin cursor does not move, so a client that sees `"timeout"` can retry the pick
 * instead of treating it as "no usable account" — a real pick made after a client gave up
 * waiting would otherwise be lost, and a retry that also picked would double-consume.
 */
export async function pickCodexAccount(opts: CodexPickOptions = {}): Promise<PickedAccount | null | "timeout"> {
  if (listCodexAccounts().length === 0) return null;
  const usages = opts.usageBudgetMs != null
    ? await settleWithinBudget(getAllCodexUsages(), opts.usageBudgetMs, null, "codex usage")
    : await getAllCodexUsages();
  if (usages === null) return "timeout";
  // A failed usage fetch yields {} → +Infinity, which the selector reads as "unknown", not
  // as "capped": an account we could not measure stays a candidate.
  const picked = selectCodexAccount({ usageOf: (id) => codexUsageLevel(usages[id]) });
  if (!picked) return null;
  return { id: picked.id, label: picked.label };
}
