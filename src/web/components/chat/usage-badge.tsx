import { useState, useEffect, useRef } from "react";
import { Activity, RefreshCw, Eye, Download, Upload, Plus, X, Settings } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { UsageInfo, LimitBucket } from "../../../types/chat";
import {
  getAccounts,
  getActiveAccount,
  getAllAccountUsages,
  patchAccount,
  type AccountInfo,
  type AccountUsageEntry,
  type OAuthProfileData,
} from "../../lib/api-settings";
import { AddAccountDialog, ExportAccountsDialog, ImportAccountsDialog } from "./account-dialogs";
import { AccountRotationSettings } from "./account-rotation-settings";

interface UsageBadgeProps {
  usage: UsageInfo;
  loading?: boolean;
  onClick?: () => void;
}

function pctColor(pct: number): string {
  if (pct >= 90) return "text-red-500";
  if (pct >= 70) return "text-amber-500";
  return "text-green-500";
}

function barColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-green-500";
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

function formatResetTime(bucket?: LimitBucket): string | null {
  if (!bucket) return null;
  let totalMins: number | null = null;
  if (bucket.resetsInMinutes != null) {
    totalMins = bucket.resetsInMinutes;
  } else if (bucket.resetsInHours != null) {
    totalMins = Math.round(bucket.resetsInHours * 60);
  } else if (bucket.resetsAt) {
    const diff = new Date(bucket.resetsAt).getTime() - Date.now();
    totalMins = diff > 0 ? Math.ceil(diff / 60_000) : 0;
  }
  if (totalMins == null) return null;
  if (totalMins <= 0) return "now";
  const d = Math.floor(totalMins / 1440);
  const h = Math.floor((totalMins % 1440) / 60);
  const m = totalMins % 60;
  if (d > 0) return m > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function BucketRow({ label, bucket }: { label: string; bucket?: LimitBucket }) {
  if (!bucket) return null;
  const pct = Math.round(bucket.utilization * 100);
  const reset = formatResetTime(bucket);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-primary">{label}</span>
        {reset && (
          <span className="text-[10px] text-text-subtle" title="Resets in">↻ {reset}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-border overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${barColor(pct)}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <span className={`text-xs font-medium tabular-nums w-10 text-right ${pctColor(pct)}`}>
          {pct}%
        </span>
      </div>
    </div>
  );
}

function formatExpiry(expiresAt: number): string {
  const diff = expiresAt - Date.now();
  if (diff <= 0) return "expired";
  const mins = Math.ceil(diff / 60_000);
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${mins % 60}m`;
  return `${mins}m`;
}

/** Derive a human-readable token status from account info */
function tokenStatus(info?: AccountInfo): { label: string; tip: string; color: string } {
  if (!info) return { label: "unknown", tip: "No account info available", color: "text-text-subtle" };
  if (!info.expiresAt) return { label: "key", tip: "API key (no expiry)", color: "text-text-subtle" };
  const expired = info.expiresAt * 1000 < Date.now(); // expiresAt is seconds
  if (expired && info.hasRefreshToken) return { label: "expired", tip: "Token expired but has refresh token — will auto-renew", color: "text-amber-500" };
  if (expired) return { label: "expired", tip: "Token expired, no refresh token", color: "text-red-500" };
  if (info.hasRefreshToken) return { label: "long-lived", tip: "OAuth token with refresh — long-lived", color: "text-green-500" };
  return { label: "temp", tip: "Temporary token without refresh — will expire", color: "text-amber-500" };
}

function formatLastUpdated(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hrs < 24) return remainMins > 0 ? `${hrs}h ${remainMins}m ago` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function AccountUsageCard({ entry, isActive, accountInfo, onToggle, onExport, onViewProfile, flash }: {
  entry: AccountUsageEntry;
  isActive: boolean;
  accountInfo?: AccountInfo;
  onToggle?: (id: string, status: string) => void;
  onExport?: (id: string) => void;
  onViewProfile?: (profile: OAuthProfileData) => void;
  flash?: boolean;
}) {
  const { usage } = entry;
  const hasBuckets = usage.session || usage.weekly || usage.weeklyOpus || usage.weeklySonnet;
  const status = accountInfo?.status ?? entry.accountStatus;

  return (
    <div className={`rounded-md border p-2 space-y-1.5 transition-colors duration-500 min-w-[200px] shrink-0 snap-start ${flash ? "bg-primary/10 border-primary/40" : ""} ${isActive ? "border-primary/30 bg-primary/5" : "border-border/50"}`}>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium truncate flex-1 min-w-0">
          {entry.accountLabel ?? entry.accountId.slice(0, 8)}
        </span>
        {!entry.isOAuth && (
          <span className="text-[9px] text-text-subtle shrink-0">API key</span>
        )}
        {/* Account controls */}
        <div className="flex items-center gap-0.5 shrink-0">
          {onViewProfile && accountInfo?.profileData && (
            <button
              className="p-1 rounded cursor-pointer text-text-subtle hover:text-foreground hover:bg-surface-elevated transition-colors"
              onClick={() => onViewProfile(accountInfo.profileData!)}
              title="View profile"
            >
              <Eye className="size-3" />
            </button>
          )}
          {onExport && entry.isOAuth && (
            <button
              className="p-1 rounded cursor-pointer text-text-subtle hover:text-blue-500 hover:bg-surface-elevated transition-colors"
              onClick={() => onExport(entry.accountId)}
              title="Export this account"
            >
              <Download className="size-3" />
            </button>
          )}
          {onToggle && (
            <Switch
              checked={status !== "disabled"}
              onCheckedChange={() => onToggle(entry.accountId, status)}
              disabled={status === "cooldown"}
              className="scale-[0.6] cursor-pointer"
            />
          )}
        </div>
      </div>
      {hasBuckets ? (
        <div className="space-y-1.5">
          <BucketRow label="5-Hour Session" bucket={usage.session} />
          <BucketRow label="Weekly" bucket={usage.weekly} />
          <BucketRow label="Weekly (Opus)" bucket={usage.weeklyOpus} />
          <BucketRow label="Weekly (Sonnet)" bucket={usage.weeklySonnet} />
        </div>
      ) : (
        <p className="text-[10px] text-text-subtle">
          {entry.isOAuth ? "No usage data yet" : "Usage tracking not available for API keys"}
        </p>
      )}
      {/* Footer: updated · expires · type */}
      {(() => {
        const ts = tokenStatus(accountInfo);
        return (
          <div className="flex items-center gap-1.5 text-[9px] text-text-subtle flex-wrap">
            {usage.lastFetchedAt && (
              <span title="Last usage data update">↻ {formatLastUpdated(new Date(usage.lastFetchedAt).getTime())}</span>
            )}
            {accountInfo?.expiresAt && accountInfo.expiresAt * 1000 > Date.now() && (
              <span title="Token expires in">⏱ {formatExpiry(accountInfo.expiresAt * 1000)}</span>
            )}
            <span className={ts.color} title={ts.tip}>© {ts.label}</span>
          </div>
        );
      })()}
    </div>
  );
}

export function UsageDetailPanel({ usage, visible, onClose, onReload, loading, lastFetchedAt }: UsageDetailPanelProps) {
  const [allUsages, setAllUsages] = useState<AccountUsageEntry[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [profileView, setProfileView] = useState<OAuthProfileData | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showRotationSettings, setShowRotationSettings] = useState(false);
  const [exportPreselect, setExportPreselect] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prevUsagesRef = useRef<AccountUsageEntry[]>([]);

  function showMessage(msg: string) {
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMessage(msg);
    msgTimer.current = setTimeout(() => setMessage(null), 4000);
  }

  function handleSuccess(msg?: string) {
    loadAll();
    if (msg) showMessage(msg);
  }

  async function loadAll() {
    const isRefresh = allUsages.length > 0;
    if (isRefresh) setRefreshing(true); else setInitialLoading(true);

    const [usages, accs, active] = await Promise.allSettled([
      getAllAccountUsages(), getAccounts(), getActiveAccount(),
    ]);

    if (usages.status === "fulfilled") {
      const newUsages = usages.value;
      // Detect which accounts changed usage values
      if (isRefresh && prevUsagesRef.current.length > 0) {
        const changed = new Set<string>();
        const prevMap = new Map(prevUsagesRef.current.map(u => [u.accountId, u]));
        for (const nu of newUsages) {
          const prev = prevMap.get(nu.accountId);
          if (!prev) { changed.add(nu.accountId); continue; }
          const pu = prev.usage, cu = nu.usage;
          if (pu.session?.utilization !== cu.session?.utilization
            || pu.weekly?.utilization !== cu.weekly?.utilization
            || pu.weeklyOpus?.utilization !== cu.weeklyOpus?.utilization
            || pu.weeklySonnet?.utilization !== cu.weeklySonnet?.utilization) {
            changed.add(nu.accountId);
          }
        }
        if (changed.size > 0) {
          setFlashIds(changed);
          setTimeout(() => setFlashIds(new Set()), 1500);
        }
      }
      prevUsagesRef.current = newUsages;
      setAllUsages(newUsages);
    }
    if (accs.status === "fulfilled") setAccounts(accs.value);
    if (active.status === "fulfilled") setActiveAccountId(active.value?.id ?? null);
    setInitialLoading(false);
    setRefreshing(false);
  }

  useEffect(() => {
    if (!visible) return;
    loadAll();
  }, [visible]);

  // Re-fetch account usages after parent refreshes from Anthropic API
  useEffect(() => {
    if (!visible || !lastFetchedAt) return;
    loadAll();
  }, [lastFetchedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) return null;

  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const hasCost = usage.queryCostUsd != null || usage.totalCostUsd != null;
  const hasMultipleAccounts = allUsages.length > 0;

  async function handleToggle(id: string, status: string) {
    await patchAccount(id, { status: status === "disabled" ? "active" : "disabled" });
    loadAll();
    onReload?.();
  }

  function openExportAll() {
    setExportPreselect(null);
    setShowExportDialog(true);
  }

  return (
    <div className="border-b border-border bg-surface px-3 py-2.5 space-y-2.5 max-h-[350px] overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary">Usage & Accounts</span>
          {lastFetchedAt && (
            <span className="text-[10px] text-text-subtle">{formatLastUpdated(new Date(lastFetchedAt).getTime())}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowRotationSettings(true)}
            className="text-xs text-text-subtle hover:text-text-primary px-1 cursor-pointer"
            title="Rotation & retry settings"
          >
            <Settings className="size-3" />
          </button>
          {onReload && (
            <button
              onClick={() => { onReload(); loadAll(); }}
              disabled={loading || refreshing}
              className="text-xs text-text-subtle hover:text-text-primary px-1 disabled:opacity-50 cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className={`size-3 ${(loading || refreshing) ? "animate-spin" : ""}`} />
            </button>
          )}
          <button
            onClick={onClose}
            className="text-xs text-text-subtle hover:text-text-primary px-1 cursor-pointer"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {message && (
        <div className="text-[11px] p-1.5 rounded bg-green-500/10 text-green-600 text-center animate-in fade-in duration-200">
          {message}
        </div>
      )}

      {(hasMultipleAccounts || initialLoading) ? (
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-3 px-3 snap-x snap-mandatory scrollbar-thin">
          {initialLoading ? (
            <p className="text-[10px] text-text-subtle">Loading...</p>
          ) : (
            allUsages.map((entry) => (
              <AccountUsageCard
                key={entry.accountId}
                entry={entry}
                isActive={entry.accountId === (activeAccountId ?? usage.activeAccountId)}
                accountInfo={accountMap.get(entry.accountId)}
                onToggle={handleToggle}
                onExport={(id) => { setExportPreselect(id); setShowExportDialog(true); }}
                onViewProfile={setProfileView}
                flash={flashIds.has(entry.accountId)}
              />
            ))
          )}
        </div>
      ) : (
        <>
          {usage.session || usage.weekly || usage.weeklyOpus || usage.weeklySonnet ? (
            <div className="space-y-2.5">
              <BucketRow label="5-Hour Session" bucket={usage.session} />
              <BucketRow label="Weekly" bucket={usage.weekly} />
              <BucketRow label="Weekly (Opus)" bucket={usage.weeklyOpus} />
              <BucketRow label="Weekly (Sonnet)" bucket={usage.weeklySonnet} />
            </div>
          ) : (
            <p className="text-xs text-text-subtle">No usage data available</p>
          )}
        </>
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

      {/* Inline profile popup */}
      {profileView && (
        <div className="border-t border-border pt-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-medium text-text-subtle">Profile</span>
            <button className="text-text-subtle hover:text-foreground cursor-pointer" onClick={() => setProfileView(null)}>
              <X className="size-3" />
            </button>
          </div>
          <div className="grid grid-cols-[70px_1fr] gap-x-2 gap-y-0.5 text-[10px]">
            {profileView.account?.display_name && <><span className="text-text-subtle">Name</span><span>{profileView.account.display_name}</span></>}
            {profileView.account?.email && <><span className="text-text-subtle">Email</span><span>{profileView.account.email}</span></>}
            {profileView.organization?.name && <><span className="text-text-subtle">Org</span><span>{profileView.organization.name}</span></>}
            {profileView.organization?.organization_type && <><span className="text-text-subtle">Type</span><span>{profileView.organization.organization_type}</span></>}
            {profileView.organization?.rate_limit_tier && <><span className="text-text-subtle">Tier</span><span>{profileView.organization.rate_limit_tier}</span></>}
            {profileView.organization?.subscription_status && <><span className="text-text-subtle">Status</span><span>{profileView.organization.subscription_status}</span></>}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="border-t border-border pt-2 flex gap-1.5">
        <button onClick={() => setShowAddDialog(true)} className="flex-1 flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer">
          <Plus className="size-3" /> Add
        </button>
        <button onClick={openExportAll} className="flex-1 flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer">
          <Download className="size-3" /> Export
        </button>
        <button onClick={() => setShowImportDialog(true)} className="flex-1 flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer">
          <Upload className="size-3" /> Import
        </button>
      </div>

      {/* Account dialogs */}
      <AddAccountDialog open={showAddDialog} onOpenChange={setShowAddDialog} onSuccess={handleSuccess} />
      <ExportAccountsDialog open={showExportDialog} onOpenChange={(v) => { setShowExportDialog(v); if (!v) setExportPreselect(null); }} accounts={accounts} preselectId={exportPreselect} onMessage={showMessage} />
      <ImportAccountsDialog open={showImportDialog} onOpenChange={setShowImportDialog} onSuccess={handleSuccess} />
      <AccountRotationSettings open={showRotationSettings} onOpenChange={setShowRotationSettings} />
    </div>
  );
}
