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
import { Activity, ExternalLink, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import type { UsageInfo } from "../../../types/chat";
import { openSettings } from "@/components/settings/open-settings";
import { AccountCard } from "@/components/settings/accounts/account-card";
import { AccountBucketRow } from "@/components/settings/accounts/account-bucket-row";
import { useAccountsData } from "@/components/settings/accounts/use-accounts-data";
import { formatLastUpdated, pctColor } from "@/components/settings/accounts/account-usage-format";

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
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors hover:bg-surface-hover ${colorClass}`}
      title="Click for usage details"
    >
      {loading ? <RefreshCw className="size-3 animate-spin" /> : <Activity className="size-3" />}
      <span>5h:{fiveHourLabel}</span>
      <span className="text-text-subtle">·</span>
      <span>Wk:{sevenDayLabel}</span>
    </button>
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
  onSelectAccount?: (accountId: string, label: string | null) => void | Promise<void>;
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
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  if (!visible) return null;

  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  /**
   * Why an account cannot take this chat, in the words the card shows.
   *
   * Only the reasons the server itself refuses — disabled, or a token past saving. Being
   * near a quota cap is not one of them: that is a slower turn, not an impossible one, and
   * a user who picks a nearly-capped account on purpose is allowed to.
   */
  function unselectableReason(info?: (typeof accounts)[number]): string | null {
    if (!info) return null;
    if (info.status === "disabled") return "Disabled";
    const expired = !info.hasRefreshToken && info.expiresAt && info.expiresAt < Math.floor(Date.now() / 1000);
    return expired ? "Token expired — sign in again" : null;
  }

  async function handleToggle(id: string, status: string) {
    setToggleError(await toggle(id, status));
  }

  async function handleSelect(accountId: string) {
    if (!onSelectAccount) return;
    setSelectingId(accountId);
    try {
      // The label travels with the id: a tab that has no session yet displays the choice
      // straight away, and it is the only place that knows the human-readable name.
      const label = usages.find((u) => u.accountId === accountId)?.accountLabel ?? null;
      await onSelectAccount(accountId, label);
    } finally {
      setSelectingId(null);
    }
  }

  const hasCost = usage.queryCostUsd != null || usage.totalCostUsd != null;
  const hasPerAccountUsage = usages.length > 0;

  // Roughly square, so the cards fill the viewport instead of leaving a long empty column.
  const fsCount = usages.length || 1;
  const fsCols = Math.ceil(Math.sqrt(fsCount));
  const fsRows = Math.ceil(fsCount / fsCols);

  return (
    <div
      className={`relative border-b border-border bg-surface px-3 py-2.5 ${
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col gap-2.5 overflow-hidden"
          : "space-y-2.5 max-h-[350px] overflow-y-auto"
      }`}
    >
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary">Usage</span>
          {lastFetchedAt && (
            <span className="text-[10px] text-text-subtle">{formatLastUpdated(new Date(lastFetchedAt).getTime())}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => openSettings("accounts")}
            className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-primary px-1 cursor-pointer"
            title="Add, remove or rotate accounts"
          >
            Manage accounts <ExternalLink className="size-3" />
          </button>
          {hasPerAccountUsage && (
            <button
              onClick={() => setIsFullscreen((v) => !v)}
              className="text-xs text-text-subtle hover:text-text-primary px-1 cursor-pointer"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen view"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen view"}
            >
              {isFullscreen ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
            </button>
          )}
          {onReload && (
            <button
              onClick={() => { onReload(); void reload(); }}
              disabled={loading || refreshing}
              className="text-xs text-text-subtle hover:text-text-primary px-1 disabled:opacity-50 cursor-pointer"
              title="Refresh"
              aria-label="Refresh usage"
            >
              <RefreshCw className={`size-3 ${(loading || refreshing) ? "animate-spin" : ""}`} />
            </button>
          )}
          <button
            onClick={() => { setIsFullscreen(false); onClose(); }}
            className="text-xs text-text-subtle hover:text-text-primary px-1 cursor-pointer"
            aria-label="Close usage panel"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {/* The server distinguishes "this login was rejected, sign in again" from "could not
          reach Anthropic, try shortly", and the difference decides what the user should do.
          Showing its words verbatim is the only way that survives to them. */}
      {toggleError && (
        <div className="shrink-0 flex items-start gap-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 text-[11px] text-error">
          <span className="flex-1">{toggleError}</span>
          <button
            onClick={() => setToggleError(null)}
            className="shrink-0 text-error/70 hover:text-error cursor-pointer"
            aria-label="Dismiss"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      {hasPerAccountUsage || initialLoading ? (
        <div
          className={isFullscreen
            ? "flex-1 min-h-0 grid gap-2 overflow-hidden"
            // Same classes as AccountCardRow, with the panel's wider padding to clear.
            : "flex gap-2 overflow-x-auto pb-1 -mx-3 px-3 snap-x snap-mandatory scrollbar-thin"}
          style={isFullscreen ? {
            gridTemplateColumns: `repeat(${fsCols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${fsRows}, minmax(0, 1fr))`,
          } : undefined}
        >
          {initialLoading ? (
            <p className="text-[10px] text-text-subtle">Loading...</p>
          ) : (
            usages.map((entry) => {
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
                  layout={isFullscreen ? "grid" : "strip"}
                  onSelect={onSelectAccount ? handleSelect : undefined}
                  unselectableReason={unselectableReason(info)}
                  selecting={selectingId === entry.accountId}
                  onToggle={handleToggle}
                  toggling={togglingId === entry.accountId}
                />
              );
            })
          )}
        </div>
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

      {hasCost && (
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
      )}
    </div>
  );
}
