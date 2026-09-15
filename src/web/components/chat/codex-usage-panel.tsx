/**
 * The chat header's Codex usage panel.
 *
 * Deliberately the same panel as the Claude one, not a lookalike: the frame comes from
 * `UsagePanelShell` and every card is the `AccountCard` that Settings renders. It used to
 * draw both itself, which is how the two ended up with cards of different shapes stacked in
 * different directions — the drift the shared Settings layout exists to stop.
 *
 * What stays Codex-specific is only what genuinely differs: its accounts come from
 * `/api/codex-accounts` rather than the Claude pool, an account is a CODEX_HOME rather than
 * an OAuth grant so there is no token to expire, and a plan may have no 5-hour window at
 * all — so the quota rows follow what the account actually reports.
 */

import { useState, useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { AccountCard } from "@/components/settings/accounts/account-card";
import { AccountCardShell } from "@/components/settings/accounts/accounts-pane-header";
import { AccountBucketRow } from "@/components/settings/accounts/account-bucket-row";
import { formatResetTime } from "@/components/settings/accounts/account-usage-format";
import type { AccountUsageEntry } from "@/lib/api-settings";
import type { UsageInfo } from "../../../types/chat";
import { codexPlanLabel } from "../../../shared/codex-plan-label.ts";
import { UsagePanelShell } from "./usage-panel-shell";

interface CodexAccount { id: string; label: string; type: string; planType?: string | null; status?: "active" | "disabled" }
type Usage = Pick<UsageInfo, "fiveHour" | "sevenDay" | "session" | "weekly">;

/** Matches the whole-percent figure the bars show, so a refusal agrees with the card. */
function atCap(util: number | null | undefined): boolean {
  return Math.round((util ?? 0) * 100) >= 100;
}

/**
 * A Codex account in the shape every account card speaks.
 *
 * `isOAuth` carries the account kind rather than an OAuth fact: a `chatgpt` account is a
 * sign-in and an `apiKey` one is a static key, which is exactly the distinction the card's
 * "API key" badge already draws.
 */
function toEntry(account: CodexAccount, usage: Usage): AccountUsageEntry {
  return {
    accountId: account.id,
    accountLabel: account.label,
    accountStatus: account.status ?? "active",
    isOAuth: account.type !== "apiKey",
    usage: { session: usage.session, weekly: usage.weekly },
  };
}

export function CodexUsagePanel({ onClose, usage, onReload, onSelectAccount, selectedAccountId }: {
  onClose: () => void;
  usage: UsageInfo;
  /** Forces the chat usage endpoint to bypass its provider-usage cache. */
  onReload?: () => void | Promise<void>;
  /** Route this chat onto another Codex account. */
  onSelectAccount?: (accountId: string, label: string | null) => Promise<string | null>;
  /** Account currently claimed or bound for this chat. */
  selectedAccountId?: string | null;
}) {
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [usages, setUsages] = useState<Record<string, Usage>>({});
  const [loading, setLoading] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ accounts: CodexAccount[] }>("/api/codex-accounts");
      setAccounts(d.accounts);
      const u = await api.get<Record<string, Usage>>("/api/codex-accounts/usage");
      setUsages(u);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // Unlike the account-list endpoint, the chat refresh carries refresh=1
      // and invalidates Codex's five-minute provider-usage cache first.
      await onReload?.();
      const u = await api.get<Record<string, Usage>>("/api/codex-accounts/usage");
      setUsages(u);
    } catch { /* retain the last successful reading */ } finally { setLoading(false); }
  }, [onReload]);

  /**
   * Why an account cannot take this chat, in the words the card shows.
   *
   * Reached, not approaching: an account at 96% still answers, one at 100% does not. Both
   * windows are checked because a plan may have only one of them, and whichever it has is
   * the one that refuses the turn.
   */
  const unselectableReason = useCallback((account: CodexAccount, u: Usage): string | null => {
    if (account.status === "disabled") return "Disabled";
    if (atCap(u.fiveHour)) return `5-hour limit reached${u.session?.resetsAt ? ` — resets ${formatResetTime(u.session)}` : ""}`;
    if (atCap(u.sevenDay)) return `Weekly limit reached${u.weekly?.resetsAt ? ` — resets ${formatResetTime(u.weekly)}` : ""}`;
    return null;
  }, []);

  const handleSelect = useCallback(async (accountId: string) => {
    if (!onSelectAccount) return;
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    // Refuse here rather than leaving the button inert: the user pressed something and is
    // owed the reason. The server checks again, which catches an account that became
    // unusable between this render and the click.
    const refused = unselectableReason(account, usages[accountId] ?? {});
    if (refused) { setPanelError(`Cannot switch to this account — ${refused.toLowerCase()}.`); return; }
    setSelectingId(accountId);
    setPanelError(null);
    try { setPanelError((await onSelectAccount(accountId, account.label)) ?? null); }
    finally { setSelectingId(null); }
  }, [onSelectAccount, accounts, usages, unselectableReason]);

  /**
   * Switch a Codex account on or off without leaving the chat.
   *
   * No pending-token dance like the Claude side: the Codex route answers immediately because
   * there is no refresh token to prove. The pending id is still tracked so the switch cannot
   * be double-fired on a slow connection.
   */
  const handleToggle = useCallback(async (id: string, status: string) => {
    setTogglingId(id);
    setPanelError(null);
    try {
      await api.patch(`/api/codex-accounts/${id}`, { status: status === "disabled" ? "active" : "disabled" });
      const d = await api.get<{ accounts: CodexAccount[] }>("/api/codex-accounts");
      setAccounts(d.accounts);
    } catch (e) {
      setPanelError((e as Error).message || "Could not change the account");
    } finally {
      setTogglingId(null);
    }
  }, []);

  /* No managed accounts → chats run on the ambient ~/.codex login, whose usage arrives on
     the session prop rather than from the accounts endpoint. */
  const ambient = loading && accounts.length === 0 ? (
    <div className="text-xs text-text-subtle flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>
  ) : (
    <>
      <AccountCardShell active={false}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate flex-1 min-w-0">{usage.activeAccountLabel || "Default login"}</span>
          <span className="text-[10px] uppercase tracking-wide text-text-subtle border border-border rounded px-1 shrink-0">~/.codex</span>
        </div>
        <div className="space-y-2">
          <AccountBucketRow label="5-Hour Session" bucket={usage.session} />
          <AccountBucketRow label="Weekly" bucket={usage.weekly} />
          {!usage.session && !usage.weekly && <p className="text-xs text-text-subtle">No usage data yet</p>}
        </div>
      </AccountCardShell>
      <p className="text-[11px] text-text-subtle">Using your default <code>~/.codex</code> login. Add managed accounts in Settings → AI Provider → Codex.</p>
    </>
  );

  return (
    <UsagePanelShell
      title="Codex Usage"
      onClose={onClose}
      onReload={onReload ? () => void reload() : undefined}
      reloading={loading}
      error={panelError}
      onDismissError={() => setPanelError(null)}
      cardCount={accounts.length}
      fallback={ambient}
    >
      {(layout) => accounts.map((a) => {
        const u = usages[a.id] ?? {};
        return (
          <AccountCard
            key={a.id}
            entry={toEntry(a, u)}
            // What is serving THIS chat, not what the rotation would pick next —
            // those differ the moment a session is bound to an account.
            isActive={a.id === (selectedAccountId ?? usage.activeAccountId)}
            layout={layout}
            planLabel={codexPlanLabel(a.planType)}
            onSelect={onSelectAccount ? handleSelect : undefined}
            unselectableReason={unselectableReason(a, u)}
            selecting={selectingId === a.id}
            onToggle={handleToggle}
            toggling={togglingId === a.id}
          />
        );
      })}
    </UsagePanelShell>
  );
}
