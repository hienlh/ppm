/**
 * One account: name, badges, per-account controls, its rate-limit buckets, and a footer of
 * token facts.
 *
 * Three layouts, because the two callers want opposite things. Settings manages accounts one
 * at a time, so `list` gives each card the full width. The chat panel is for comparing them
 * at a glance, so `strip` makes fixed-width cards that scroll sideways and `grid` fills a
 * cell of the fullscreen view — stacked vertically, comparing two accounts meant scrolling
 * past the one above.
 *
 * An expired account (past `expiresAt` AND no refresh token) is dimmed and loses every
 * control except delete — toggling or exporting a token the server can no longer renew only
 * produces confusing failures.
 *
 * The footer states what the user can act on and nothing else. It deliberately no longer
 * counts down the access token: that number renews itself every few hours, no one can do
 * anything about it, and it is what made two revoked accounts look healthy for six days
 * while every turn on them failed. The sign-in deadline replaced it.
 */

import { CircleHelp, Download, Eye, KeyRound, RefreshCw, Trash2 } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import type { AccountInfo, AccountUsageEntry, OAuthProfileData } from "../../../lib/api-settings";
import { AccountBucketRow } from "./account-bucket-row";
import { AccountHint } from "./account-hint";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountCardShell } from "./accounts-pane-header";
import { formatExpiry, formatLastUpdated, tokenStatus } from "./account-usage-format";
import type { DailyGuardState } from "../../../../shared/codex-daily-guard.ts";

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
  /**
   * Move the current chat session onto this account. Omitted in Settings, where a card
   * manages an account rather than routing a conversation to it — leaving it out is what
   * keeps that screen behaving exactly as before.
   */
  onSelect?: (id: string) => void;
  /** Why this account cannot be selected. Present means the choice is refused, and says so. */
  unselectableReason?: string | null;
  /** A selection is in flight for this card. */
  selecting?: boolean;
  /** `list` fills the width, `strip` is a fixed-width card in a sideways scroller, `grid`
   *  fills a cell of the fullscreen grid. */
  layout?: "list" | "strip" | "grid";
  /** The subscription tier this account is on, when the provider reports one. Codex names
   *  a plan ("plus", "team") and that decides which quota windows the account even has, so
   *  it belongs on the card; Claude reports none and the badge simply does not appear. */
  planLabel?: string | null;
  /** Optional pacing control for Codex accounts that expose only a weekly quota. */
  dailyGuard?: { enabled: boolean; state: DailyGuardState };
  onDailyGuardToggle?: () => void;
  dailyGuardToggling?: boolean;
}

// Fixed widths so a row scrolls instead of squeezing. Two of them: a read-only card holds a
// name and its bars, but a card that also carries view/export/toggle/delete needs room for
// four controls beside the name, and at the read-only width that header wraps.
const STRIP_WIDTH = { readOnly: "min-w-[220px]", withActions: "min-w-[300px]" } as const;

export function AccountCard({
  entry, isActive, accountInfo, onToggle, toggling, onDelete, onExport, onViewProfile, flash,
  onSelect, unselectableReason, selecting, planLabel, dailyGuard, onDailyGuardToggle, dailyGuardToggling,
  layout = "list",
}: AccountCardProps) {
  const { usage } = entry;
  const hasBuckets = usage.session || usage.weekly || usage.weeklyOpus || usage.weeklySonnet;
  const status = accountInfo?.status ?? entry.accountStatus;
  const isExpired = !!(
    accountInfo && !accountInfo.hasRefreshToken && accountInfo.expiresAt
    && accountInfo.expiresAt < Math.floor(Date.now() / 1000)
  );
  const ts = tokenStatus(accountInfo);
  // Distinct from isExpired: this account still holds a refresh token, it is just one the
  // server will not honour. Dim it like an expired card, but keep every control — signing
  // in again goes through the same add flow, and delete has to stay reachable.
  const needsReauth = !!accountInfo?.reauthRequired;
  // A sign-in dies on a fixed schedule regardless of use, so the warning has to lead the
  // last stretch of it rather than appear once it is already too late.
  const grantExpiresAtMs = accountInfo?.grantExpiresAt ? accountInfo.grantExpiresAt * 1000 : null;
  const grantEndingSoon = !!grantExpiresAtMs && grantExpiresAtMs - Date.now() < 5 * 86_400_000;
  // The header already badges Expired, Sign in again and API key, and "long-lived" only
  // restates what the sign-in chip beside it implies. That leaves the two states nothing
  // else announces: a temporary token with no way to renew, and one that has lapsed but
  // still has a refresh token behind it.
  //
  // Gated on there being an `accountInfo` at all. Without one `tokenStatus` reports
  // "unknown", which reads as a warning about this account's token — and a Codex card has
  // no token to warn about, because its credentials live in a CODEX_HOME the server
  // authenticates against rather than in a grant with an expiry.
  const showTokenStatus = !!accountInfo && (ts.label === "temp" || ts.label === "unknown"
    || (ts.label === "expired" && !isExpired && !needsReauth));
  const grantExpiresOn = grantExpiresAtMs
    ? new Date(grantExpiresAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : null;
  const hasActions = Boolean(onToggle || onDelete || onExport || onViewProfile);
  // Every state that already dims this card also refuses the chat to it. `needsReauth` is
  // the one worth naming separately: the token is present and unexpired, so nothing else
  // here looks wrong, but the server has rejected it and no turn can run on it.
  const refusedReason = isExpired
    ? "Token expired — sign in again"
    : needsReauth
      ? "Sign in again to use this account"
      : unselectableReason ?? null;

  const layoutClass = layout === "list"
    ? ""
    : layout === "grid"
      // The cell owns the height, so the card spreads its rows into it.
      ? "flex flex-col justify-evenly overflow-hidden min-h-0"
      : `shrink-0 snap-start ${hasActions ? STRIP_WIDTH.withActions : STRIP_WIDTH.readOnly}`;

  return (
    <AccountCardShell
      active={isActive}
      flash={flash}
      dense={layout !== "list"}
      className={[layoutClass, isExpired || needsReauth ? "opacity-50" : ""].filter(Boolean).join(" ") || undefined}
      data-testid="account-card"
      data-account-id={entry.accountId}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium truncate flex-1 min-w-0">
          {entry.accountLabel ?? entry.accountId.slice(0, 8)}
        </span>
        {isActive && (
          <AccountHint className="text-[10px] text-primary shrink-0 font-medium" hint="The next turn will run on this account.">
            Active
          </AccountHint>
        )}
        {/* Occupies the slot the "Active" badge would, so a card is the same height whether
            it is the one serving or one you could switch to. A row of its own below cost
            every card that height, including the ones whose button did nothing. */}
        {onSelect && !isActive && (
          // Shown even when the account cannot serve, and clicking it then reports why.
          // Hiding it instead left a blank where the other cards have a control, which reads
          // as a missing feature rather than as a refusal with a reason behind it.
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect(entry.accountId)}
                disabled={selecting}
                className={[
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors cursor-pointer disabled:cursor-wait",
                  refusedReason
                    ? "text-text-subtle hover:text-error hover:bg-error/10"
                    : "text-text-secondary hover:text-foreground hover:bg-surface-elevated",
                ].join(" ")}
              >
                {selecting ? "Switching…" : "Use"}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{refusedReason ?? "Use this account for this chat"}</TooltipContent>
          </Tooltip>
        )}
        {isExpired && (
          <AccountHint
            className="text-[10px] text-error shrink-0 font-medium"
            hint="This token has expired and carries no refresh token, so nothing can renew it. Add the account again."
          >
            Expired
          </AccountHint>
        )}
        {needsReauth && !isExpired && (
          <AccountHint
            className="text-[10px] text-error shrink-0 font-medium"
            hint="Anthropic rejected this account's refresh token, so no turn can run on it. Signing in again is the only thing that restores it."
          >
            Sign in again
          </AccountHint>
        )}
        {!entry.isOAuth && !isExpired && (
          <AccountHint
            className="text-[10px] text-text-subtle shrink-0"
            hint="A static API key rather than a sign-in: nothing to expire and nothing to renew."
          >
            API key
          </AccountHint>
        )}
        {planLabel && (
          <AccountHint
            className="text-[10px] uppercase tracking-wide text-text-subtle shrink-0"
            hint="The subscription this account is on. It decides which quota windows the account has — some plans have a weekly limit and no shorter one."
          >
            {planLabel}
          </AccountHint>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          {!isExpired && onViewProfile && accountInfo?.profileData && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-2 rounded cursor-pointer text-text-subtle hover:text-foreground hover:bg-surface-elevated transition-colors"
                  onClick={() => onViewProfile(accountInfo.profileData!, entry.accountId)}
                  aria-label="View profile"
                >
                  <Eye className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">View profile</TooltipContent>
            </Tooltip>
          )}
          {!isExpired && onExport && entry.isOAuth && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-2 rounded cursor-pointer text-text-subtle hover:text-primary hover:bg-surface-elevated transition-colors"
                  onClick={() => onExport(entry.accountId)}
                  aria-label="Export this account"
                >
                  <Download className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Export this account</TooltipContent>
            </Tooltip>
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
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-2 rounded cursor-pointer text-text-subtle hover:text-error hover:bg-surface-elevated transition-colors"
                  onClick={() => onDelete(entry.accountId, entry.accountLabel ?? entry.accountId.slice(0, 8))}
                  aria-label="Remove account"
                >
                  <Trash2 className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Remove account</TooltipContent>
            </Tooltip>
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

      {dailyGuard && (
        <div className={`flex min-h-12 items-center justify-between gap-3 rounded-md border px-2.5 py-1.5 ${
          dailyGuard.enabled && dailyGuard.state.blocked ? "border-error/40 bg-error/5" : "border-border/50 bg-surface/40"
        }`}>
          <div className="min-w-0 space-y-0.5">
            <div className={`flex items-center gap-1.5 text-xs font-medium ${dailyGuard.enabled && dailyGuard.state.blocked ? "text-error" : "text-text-secondary"}`}>
              <span>Daily guard</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" aria-label="About Daily guard" className="text-text-subtle hover:text-text-primary cursor-help">
                    <CircleHelp className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-64 text-xs leading-relaxed">
                  Spreads the weekly quota across five weekdays, adding 20% per weekday. Weekend slots keep the previous cap; unused allowance carries forward. Daily slots start at the reset time and use UTC weekdays.
                </TooltipContent>
              </Tooltip>
            </div>
            <p className={`text-[10px] tabular-nums ${dailyGuard.enabled && dailyGuard.state.blocked ? "text-error" : "text-text-subtle"}`}>
              {dailyGuard.enabled && dailyGuard.state.blocked
                ? `${Math.round(dailyGuard.state.used * 100)}% used / ${Math.round(dailyGuard.state.cap * 100)}% daily cap. New turns paused.`
                : `Weekday ${dailyGuard.state.day}/5, ${Math.round(dailyGuard.state.cap * 100)}% daily cap`}
            </p>
          </div>
          {onDailyGuardToggle && (
            <Switch
              checked={dailyGuard.enabled}
              onCheckedChange={onDailyGuardToggle}
              disabled={dailyGuardToggling}
              aria-label={dailyGuard.enabled ? "Disable Daily guard" : "Enable Daily guard"}
              className="cursor-pointer shrink-0"
            />
          )}
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px] text-text-subtle flex-wrap">
        {usage.lastFetchedAt && (
          <AccountHint
            className="inline-flex items-center gap-1"
            hint={`Usage last read from Anthropic on ${new Date(usage.lastFetchedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. The bars above are only as current as this.`}
          >
            <RefreshCw className="size-3 shrink-0" aria-hidden />
            {formatLastUpdated(new Date(usage.lastFetchedAt).getTime())}
          </AccountHint>
        )}
        {grantExpiresAtMs && !needsReauth && (
          <AccountHint
            className={["inline-flex items-center gap-1", grantEndingSoon ? "text-warning" : ""].filter(Boolean).join(" ")}
            hint={`Sign-in stops working on ${grantExpiresOn}. Anthropic ends every sign-in on a fixed schedule from the day it was made, whether or not the account gets used — refreshing does not extend it. After that the account fails until you sign in again.`}
          >
            <KeyRound className="size-3 shrink-0" aria-hidden />
            sign-in {formatExpiry(grantExpiresAtMs)}
          </AccountHint>
        )}
        {showTokenStatus && (
          <AccountHint className={ts.color} hint={ts.tip}>© {ts.label}</AccountHint>
        )}
      </div>

    </AccountCardShell>
  );
}
