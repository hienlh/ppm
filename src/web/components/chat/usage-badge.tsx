/**
 * The chat header's usage chip and the panel it opens.
 *
 * Display only. Adding, removing, enabling, exporting and rotating accounts all live in
 * Settings → Accounts; this panel links there instead of carrying its own copy of those
 * controls, which is what let the two drift apart. The account cards are the same component
 * the Settings pane renders — passing no action callbacks is what makes them read-only, so
 * there is one card implementation rather than a display twin.
 */

import { Activity, ExternalLink, RefreshCw, X } from "lucide-react";
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
}

export function UsageDetailPanel({ usage, visible, onClose, onReload, loading, lastFetchedAt }: UsageDetailPanelProps) {
  // Fetching is gated on visibility: the panel is collapsed most of the time, and its
  // usage endpoint is the expensive one.
  const { usages, accounts, activeAccountId, initialLoading, refreshing, flashIds, reload } = useAccountsData(visible);

  if (!visible) return null;

  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const hasCost = usage.queryCostUsd != null || usage.totalCostUsd != null;
  const hasPerAccountUsage = usages.length > 0;

  return (
    <div className="relative border-b border-border bg-surface px-3 py-2.5 space-y-2.5 max-h-[350px] overflow-y-auto">
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
            onClick={onClose}
            className="text-xs text-text-subtle hover:text-text-primary px-1 cursor-pointer"
            aria-label="Close usage panel"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {hasPerAccountUsage || initialLoading ? (
        <div className="space-y-1.5">
          {initialLoading ? (
            <p className="text-[10px] text-text-subtle">Loading...</p>
          ) : (
            usages.map((entry) => (
              <AccountCard
                key={entry.accountId}
                entry={entry}
                isActive={entry.accountId === (activeAccountId ?? usage.activeAccountId)}
                accountInfo={accountMap.get(entry.accountId)}
                flash={flashIds.has(entry.accountId)}
              />
            ))
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
