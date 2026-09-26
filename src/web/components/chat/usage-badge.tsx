/**
 * The chat header's usage chip and the panel it opens.
 *
 * Adding, removing, exporting and rotating accounts live in Settings → Accounts; this panel
 * links there rather than carrying its own copy of them. What it does carry is the two
 * decisions that belong to the conversation in front of you: which account serves it, and
 * whether an account is available at all.
 *
 * The rule the original separation was protecting still holds, and is what makes those two
 * safe to have here: the cards are the same component the Settings pane renders, and the
 * switch drives the same `useAccountsData().toggle` that pane drives. One implementation, two
 * places it appears — not a display twin that can drift.
 *
 * Accounts sit in a row that scrolls sideways, not a vertical stack: this panel exists to
 * compare them, and stacked in a 350px strip that meant scrolling past one account to see
 * the next. Fullscreen lays the same cards out as a grid when there are too many to fit.
 */

import { useState } from "react";
import { Activity, RefreshCw } from "@/lib/icons";
import type { UsageInfo } from "../../../types/chat";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountCard } from "@/components/settings/accounts/account-card";
import { AccountBucketRow } from "@/components/settings/accounts/account-bucket-row";
import { useAccountsData } from "@/components/settings/accounts/use-accounts-data";
import { formatLastUpdated, formatResetTime, pctColor } from "@/components/settings/accounts/account-usage-format";
import { UsagePanelShell } from "./usage-panel-shell";
import { AddAccountDialog } from "@/components/settings/accounts/account-add-dialog";

/** Matches the whole-percent figure the usage bars show, so a refusal agrees with the card. */
function atCap(util: number | null | undefined): boolean {
  return Math.round((util ?? 0) * 100) >= 100;
}

interface UsageBadgeProps {
  usage: UsageInfo;
  loading?: boolean;
  onClick?: () => void;
}

export function UsageBadge({ usage, loading, onClick }: UsageBadgeProps) {
  const fiveHourPct = usage.fiveHour != null ? Math.round(usage.fiveHour * 100) : null;
  const sevenDayPct = usage.sevenDay != null ? Math.round(usage.sevenDay * 100) : null;

  const fiveHourLabel = fiveHourPct != null ? `${fiveHourPct}%` : "--%";
  const sevenDayLabel = sevenDayPct != null ? `${sevenDayPct}%` : "--%";

  const worstPct = Math.max(fiveHourPct ?? 0, sevenDayPct ?? 0);
  const colorClass = fiveHourPct != null || sevenDayPct != null ? pctColor(worstPct) : "text-text-subtle";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors hover:bg-surface-hover ${colorClass}`}
        >
          {loading ? <RefreshCw className="size-3 animate-spin" /> : <Activity className="size-3" />}
          <span>5h:{fiveHourLabel}</span>
          <span className="text-text-subtle">·</span>
          <span>Wk:{sevenDayLabel}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">Click for usage details</TooltipContent>
    </Tooltip>
  );
}

// --- Detail panel ---

interface UsageDetailPanelProps {
  usage: UsageInfo;
  visible: boolean;
  onClose: () => void;
  onReload?: () => void;
  loading?: boolean;
  lastFetchedAt?: string | null;
  /** Route this chat to a different account. Omitted when the caller cannot re-route. */
  onSelectAccount?: (accountId: string, label: string | null) => Promise<string | null>;
  /** Account currently claimed or bound for this chat, so the card can mark itself. */
  selectedAccountId?: string | null;
}

export function UsageDetailPanel({
  usage, visible, onClose, onReload, loading, lastFetchedAt,
  onSelectAccount, selectedAccountId,
}: UsageDetailPanelProps) {
  const [selectingId, setSelectingId] = useState<string | null>(null);
  // Fetching is gated on visibility: the panel is collapsed most of the time, and its
  // usage endpoint is the expensive one.
  const { usages, accounts, activeAccountId, initialLoading, refreshing, flashIds, reload, toggle, togglingId } = useAccountsData(visible);
  // One strip for anything that went wrong in this panel — a refused switch or a refused
  // toggle. Two separate messages in two places would be harder to notice, not clearer.
  const [panelError, setPanelError] = useState<string | null>(null);
  /** Label of the account whose "Sign in again" chip was pressed; opens the sign-in dialog. */
  const [signInAgainFor, setSignInAgainFor] = useState<string | null>(null);

  if (!visible) return null;

  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  /**
   * Why an account cannot take this chat, in the words the card shows.
   *
   * Only the reasons the server itself refuses — disabled, or a token past saving. Being
   * near a quota cap is not one of them: that is a slower turn, not an impossible one, and
   * a user who picks a nearly-capped account on purpose is allowed to.
   */
  function unselectableReason(
    info?: (typeof accounts)[number],
    entry?: (typeof usages)[number],
  ): string | null {
    if (info) {
      if (info.status === "disabled") return "Disabled";
      // A rejected grant is refused before the token's freshness is even consulted, so such
      // an account cannot take a turn however healthy the rest of the card looks.
      if (info.reauthRequired) return "Sign in again to use this account";
      const expired = !info.hasRefreshToken && info.expiresAt && info.expiresAt < Math.floor(Date.now() / 1000);
      if (expired) return "Token expired — sign in again";
    }
    // Reached, not merely approaching. The router steers away from 95% so it can spread load
    // early, but an account at 96% still answers — refusing it would be wrong. At 100% the
    // next turn fails outright, and that is the point where saying no is the truth.
    const session = entry?.usage.session;
    if (atCap(session?.utilization)) {
      return `5-hour limit reached${session?.resetsAt ? ` — resets ${formatResetTime(session)}` : ""}`;
    }
    const weekly = entry?.usage.weekly;
    if (atCap(weekly?.utilization)) {
      return `Weekly limit reached${weekly?.resetsAt ? ` — resets ${formatResetTime(weekly)}` : ""}`;
    }
    return null;
  }

  async function handleToggle(id: string, status: string) {
    setPanelError(await toggle(id, status));
  }

  async function handleSelect(accountId: string) {
    if (!onSelectAccount) return;
    // Refuse here rather than leaving the button inert: the user pressed something and is
    // owed the reason. Checked again server-side, which is what catches an account that
    // became unusable between this render and the click.
    const refused = unselectableReason(
      accountMap.get(accountId),
      usages.find((u) => u.accountId === accountId),
    );
    if (refused) { setPanelError(`Cannot switch to this account — ${refused.toLowerCase()}.`); return; }

    setSelectingId(accountId);
    setPanelError(null);
    try {
      // The label travels with the id: a tab that has no session yet displays the choice
      // straight away, and it is the only place that knows the human-readable name.
      const label = usages.find((u) => u.accountId === accountId)?.accountLabel ?? null;
      setPanelError((await onSelectAccount(accountId, label)) ?? null);
    } finally {
      setSelectingId(null);
    }
  }

  const hasCost = usage.queryCostUsd != null || usage.totalCostUsd != null;

  return (
    <>
    <UsagePanelShell
      title="Usage"
      meta={lastFetchedAt && (
        <span className="text-[10px] text-text-subtle">{formatLastUpdated(new Date(lastFetchedAt).getTime())}</span>
      )}
      onClose={onClose}
      onReload={onReload ? () => { onReload(); void reload(); } : undefined}
      reloading={loading || refreshing}
      error={panelError}
      onDismissError={() => setPanelError(null)}
      cardCount={usages.length}
      fallback={initialLoading ? (
        <p className="text-[10px] text-text-subtle">Loading...</p>
      ) : usage.session || usage.weekly || usage.weeklyOpus || usage.weeklySonnet ? (
        <div className="space-y-2.5">
          <AccountBucketRow label="5-Hour Session" bucket={usage.session} />
          <AccountBucketRow label="Weekly" bucket={usage.weekly} />
          <AccountBucketRow label="Weekly (Opus)" bucket={usage.weeklyOpus} />
          <AccountBucketRow label="Weekly (Sonnet)" bucket={usage.weeklySonnet} />
        </div>
      ) : (
        <p className="text-xs text-text-subtle">No usage data available</p>
      )}
      footer={hasCost ? (
        <div className="border-t border-border pt-2 space-y-1">
          {usage.queryCostUsd != null && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-subtle">Last query</span>
              <span className="text-text-primary font-medium tabular-nums">
                ${usage.queryCostUsd.toFixed(4)}
              </span>
            </div>
          )}
          {usage.totalCostUsd != null && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-subtle">Session total</span>
              <span className="text-text-primary font-medium tabular-nums">
                ${usage.totalCostUsd.toFixed(4)}
              </span>
            </div>
          )}
        </div>
      ) : undefined}
    >
      {(layout) => usages.map((entry) => {
        const info = accountMap.get(entry.accountId);
        return (
          <AccountCard
            key={entry.accountId}
            entry={entry}
            // What is serving THIS chat, not what the rotation would pick next —
            // those differ the moment a session is bound to an account.
            isActive={entry.accountId === (selectedAccountId ?? usage.activeAccountId ?? activeAccountId)}
            accountInfo={info}
            flash={flashIds.has(entry.accountId)}
            layout={layout}
            onSelect={onSelectAccount ? handleSelect : undefined}
            unselectableReason={unselectableReason(info, entry)}
            selecting={selectingId === entry.accountId}
            onToggle={handleToggle}
            toggling={togglingId === entry.accountId}
            onReauth={() => setSignInAgainFor(entry.accountLabel ?? entry.accountId.slice(0, 8))}
          />
        );
      })}
    </UsagePanelShell>
    {signInAgainFor && (
      <AddAccountDialog
        open
        onOpenChange={(v) => { if (!v) setSignInAgainFor(null); }}
        onSuccess={(msg) => { setSignInAgainFor(null); void reload(); if (msg) setPanelError(msg); }}
        signInAgainFor={signInAgainFor}
      />
    )}
    </>
  );
}
