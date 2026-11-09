/**
 * The accounts the chat's "Switch account" view lists, for the chat's own provider only, loaded
 * while the ··· menu is open.
 *
 * Claude reads the same `useAccountsData` the Settings pane reads, so the two can never disagree
 * about an account; Codex reads its own `/api/codex-accounts` pair. Both end as `SwitchAccount`s,
 * and the raw Codex records are kept beside them because signing one in again needs the record.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useAccountsData } from "@/components/settings/accounts/use-accounts-data";
import type { CodexAccount, Usage as CodexUsage } from "@/components/settings/accounts/use-codex-accounts";
import { claudeSwitchAccount, codexSwitchAccount, type SwitchAccount } from "@/lib/chat-account-switch";
import { codexPlanLabel } from "../../shared/codex-plan-label";

export interface SwitchAccountsData {
  accounts: SwitchAccount[];
  /** True until the first answer for this provider has landed. */
  loading: boolean;
  reload: () => void;
  /** Codex records by id, for signing one in again. */
  codexAccounts: Map<string, CodexAccount>;
}

/** "ChatGPT Plus" reads as "Plus" on a card that already says which provider it is. */
function shortCodexPlan(planType: string | null | undefined): string | null {
  return codexPlanLabel(planType)?.replace(/^ChatGPT\s+/i, "") ?? null;
}

export function useSwitchAccounts(providerId: string | undefined, enabled: boolean): SwitchAccountsData {
  const isCodex = providerId === "codex";
  const claude = useAccountsData(enabled && !isCodex);
  const [codex, setCodex] = useState<{ accounts: CodexAccount[]; usages: Record<string, CodexUsage> } | null>(null);
  const request = useRef(0);

  const loadCodex = useCallback(async () => {
    const id = ++request.current;
    try {
      const [list, usages] = await Promise.all([
        api.get<{ accounts: CodexAccount[] }>("/api/codex-accounts"),
        api.get<Record<string, CodexUsage>>("/api/codex-accounts/usage").catch(() => ({} as Record<string, CodexUsage>)),
      ]);
      if (id === request.current) setCodex({ accounts: list.accounts, usages });
    } catch {
      // Keep the last reading: an empty list would read as "no accounts".
      if (id === request.current) setCodex((prev) => prev ?? { accounts: [], usages: {} });
    }
  }, []);

  useEffect(() => {
    if (enabled && isCodex) void loadCodex();
  }, [enabled, isCodex, loadCodex]);

  const accounts = useMemo(() => {
    if (isCodex) {
      return (codex?.accounts ?? []).map((a) => codexSwitchAccount(a, codex?.usages[a.id] ?? {}, shortCodexPlan(a.planType)));
    }
    const info = new Map(claude.accounts.map((a) => [a.id, a]));
    return claude.usages.map((u) => claudeSwitchAccount(u, info.get(u.accountId)));
  }, [isCodex, codex, claude.accounts, claude.usages]);

  const codexAccounts = useMemo(() => new Map((codex?.accounts ?? []).map((a) => [a.id, a])), [codex]);
  const reload = useCallback(() => { if (isCodex) void loadCodex(); else void claude.reload(); }, [isCodex, loadCodex, claude.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    accounts,
    loading: isCodex ? codex === null : claude.initialLoading,
    reload,
    codexAccounts,
  };
}
