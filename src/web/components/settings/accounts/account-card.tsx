/**
 * One account in the list: name, badges, per-account controls, its rate-limit buckets, and a
 * footer of token facts.
 *
 * An expired account (past `expiresAt` AND no refresh token) is dimmed and loses every
 * control except delete — toggling or exporting a token the server can no longer renew only
 * produces confusing failures.
 */

import { Download, Eye, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { AccountInfo, AccountUsageEntry, OAuthProfileData } from "../../../lib/api-settings";
import { AccountBucketRow } from "./account-bucket-row";
import { AccountCardShell } from "./accounts-pane-header";
import { formatExpiry, formatLastUpdated, tokenStatus } from "./account-usage-format";

export interface AccountCardProps {
  entry: AccountUsageEntry;
  isActive: boolean;
  accountInfo?: AccountInfo;
  onToggle?: (id: string, status: string) => void;
  toggling?: boolean;
  onDelete?: (id: string, display: string) => void;
  onExport?: (id: string) => void;
  onViewProfile?: (profile: OAuthProfileData, accountId: string) => void;
  /** Brief highlight when this account's usage numbers just changed. */
  flash?: boolean;
}

export function AccountCard({
  entry, isActive, accountInfo, onToggle, toggling, onDelete, onExport, onViewProfile, flash,
}: AccountCardProps) {
  const { usage } = entry;
  const hasBuckets = usage.session || usage.weekly || usage.weeklyOpus || usage.weeklySonnet;
  const status = accountInfo?.status ?? entry.accountStatus;
  const isExpired = !!(
    accountInfo && !accountInfo.hasRefreshToken && accountInfo.expiresAt
    && accountInfo.expiresAt < Math.floor(Date.now() / 1000)
  );
  const ts = tokenStatus(accountInfo);

  return (
    <AccountCardShell
      active={isActive}
      flash={flash}
      className={isExpired ? "opacity-50" : undefined}
      data-testid="account-card"
      data-account-id={entry.accountId}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium truncate flex-1 min-w-0">
          {entry.accountLabel ?? entry.accountId.slice(0, 8)}
        </span>
        {isActive && <span className="text-[10px] text-primary shrink-0 font-medium">Active</span>}
        {isExpired && <span className="text-[10px] text-error shrink-0 font-medium">Expired</span>}
        {!entry.isOAuth && !isExpired && (
          <span className="text-[10px] text-text-subtle shrink-0">API key</span>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          {!isExpired && onViewProfile && accountInfo?.profileData && (
            <button
              className="p-2 rounded cursor-pointer text-text-subtle hover:text-foreground hover:bg-surface-elevated transition-colors"
              onClick={() => onViewProfile(accountInfo.profileData!, entry.accountId)}
              title="View profile"
              aria-label="View profile"
            >
              <Eye className="size-4" />
            </button>
          )}
          {!isExpired && onExport && entry.isOAuth && (
            <button
              className="p-2 rounded cursor-pointer text-text-subtle hover:text-primary hover:bg-surface-elevated transition-colors"
              onClick={() => onExport(entry.accountId)}
              title="Export this account"
              aria-label="Export this account"
            >
              <Download className="size-4" />
            </button>
          )}
          {!isExpired && onToggle && (
            <Switch
              checked={status !== "disabled"}
              onCheckedChange={() => onToggle(entry.accountId, status)}
              disabled={toggling || status === "cooldown"}
              aria-label={status === "disabled" ? "Enable account" : "Disable account"}
              className="cursor-pointer"
            />
          )}
          {onDelete && (
            <button
              className="p-2 rounded cursor-pointer text-text-subtle hover:text-error hover:bg-surface-elevated transition-colors"
              onClick={() => onDelete(entry.accountId, entry.accountLabel ?? entry.accountId.slice(0, 8))}
              title="Remove account"
              aria-label="Remove account"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      </div>

      {hasBuckets ? (
        <div className="space-y-2">
          <AccountBucketRow label="5-Hour Session" bucket={usage.session} />
          <AccountBucketRow label="Weekly" bucket={usage.weekly} />
          <AccountBucketRow label="Weekly (Opus)" bucket={usage.weeklyOpus} />
          <AccountBucketRow label="Weekly (Sonnet)" bucket={usage.weeklySonnet} />
        </div>
      ) : (
        <p className="text-xs text-text-subtle">
          {entry.isOAuth ? "No usage data yet" : "Usage tracking not available for API keys"}
        </p>
      )}

      <div className="flex items-center gap-2 text-[10px] text-text-subtle flex-wrap">
        {usage.lastFetchedAt && (
          <span title="Last usage data update">↻ {formatLastUpdated(new Date(usage.lastFetchedAt).getTime())}</span>
        )}
        {accountInfo?.expiresAt && accountInfo.expiresAt * 1000 > Date.now() && (
          <span title="Token expires in">⏱ {formatExpiry(accountInfo.expiresAt * 1000)}</span>
        )}
        <span className={ts.color} title={ts.tip}>© {ts.label}</span>
      </div>
    </AccountCardShell>
  );
}
