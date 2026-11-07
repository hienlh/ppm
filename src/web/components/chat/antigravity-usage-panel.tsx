import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { AccountCard } from "@/components/settings/accounts/account-card";
import { AccountCardShell } from "@/components/settings/accounts/accounts-pane-header";
import { AccountBucketRow } from "@/components/settings/accounts/account-bucket-row";
import { formatLastUpdated, formatResetTime } from "@/components/settings/accounts/account-usage-format";
import type { AccountUsageEntry } from "@/lib/api-settings";
import type { AntigravityAccount } from "@/components/settings/accounts/antigravity-accounts-section";
import { UsagePanelShell } from "./usage-panel-shell";
import type { UsageInfo } from "../../../types/chat";

function atCap(util: number | null | undefined): boolean {
  return Math.round((util ?? 0) * 100) >= 100;
}

function toEntry(account: AntigravityAccount, usage: UsageInfo): AccountUsageEntry {
  return {
    accountId: account.id,
    accountLabel: account.label,
    accountStatus: account.status ?? "active",
    isOAuth: true,
    usage: {
      session: usage.session,
      weekly: usage.weekly,
      weeklyScoped: usage.weeklyScoped,
    },
  };
}

export function AntigravityUsagePanel({
  usage,
  loading: parentLoading,
  lastFetchedAt,
  onClose,
  onReload,
  onSelectAccount,
  selectedAccountId,
}: {
  usage: UsageInfo;
  loading?: boolean;
  lastFetchedAt?: string | null;
  onClose: () => void;
  onReload?: () => void | Promise<void>;
  onSelectAccount?: (accountId: string, label: string | null) => Promise<string | null>;
  selectedAccountId?: string | null;
}) {
  const [accounts, setAccounts] = useState<AntigravityAccount[]>([]);
  const [usages, setUsages] = useState<Record<string, UsageInfo>>({});
  const [loading, setLoading] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const refreshingRef = useRef(false);

  const load = useCallback(async () => {
    if (refreshingRef.current) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const d = await api.get<{ accounts: AntigravityAccount[] }>("/api/antigravity-accounts");
      if (request !== requestRef.current) return;
      setAccounts(d.accounts);
      const u = await api.get<Record<string, UsageInfo>>("/api/antigravity-accounts/usage");
      if (request === requestRef.current) {
        setUsages(u);
        setPanelError(null);
      }
    } catch (e) {
      if (request === requestRef.current) {
        setPanelError((e as Error).message || "Failed to load Antigravity usage");
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, 120_000);
    return () => { clearInterval(timer); ++requestRef.current; };
  }, [load]);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    refreshingRef.current = true;
    setLoading(true);
    try {
      await onReload?.();
      const [d, u] = await Promise.all([
        api.get<{ accounts: AntigravityAccount[] }>("/api/antigravity-accounts"),
        api.get<Record<string, UsageInfo>>("/api/antigravity-accounts/usage"),
      ]);
      if (request === requestRef.current) {
        setAccounts(d.accounts);
        setUsages(u);
        setPanelError(null);
      }
    } catch (e) {
      if (request === requestRef.current) {
        setPanelError((e as Error).message || "Failed to reload Antigravity usage");
      }
    } finally {
      refreshingRef.current = false;
      if (request === requestRef.current) setLoading(false);
    }
  }, [onReload]);

  const unselectableReason = useCallback((account: AntigravityAccount, u: UsageInfo): string | null => {
    if (account.status === "disabled") return "Disabled";
    if (atCap(u.fiveHour)) return `5-hour limit reached${u.session?.resetsAt ? ` — resets ${formatResetTime(u.session)}` : ""}`;
    if (atCap(u.sevenDay)) return `Weekly limit reached${u.weekly?.resetsAt ? ` — resets ${formatResetTime(u.weekly)}` : ""}`;
    return null;
  }, []);

  const handleSelect = useCallback(async (accountId: string) => {
    if (!onSelectAccount) return;
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    const refused = unselectableReason(account, usages[accountId] ?? {});
    if (refused) {
      setPanelError(`Cannot switch to this account — ${refused.toLowerCase()}.`);
      return;
    }
    setSelectingId(accountId);
    setPanelError(null);
    const displayLabel = account.planType ? `${account.label} · ${account.planType}` : account.label;
    try {
      setPanelError((await onSelectAccount(accountId, displayLabel)) ?? null);
    } finally {
      setSelectingId(null);
    }
  }, [onSelectAccount, accounts, usages, unselectableReason]);

  const handleToggle = useCallback(async (id: string, status: string) => {
    setTogglingId(id);
    setPanelError(null);
    try {
      await api.patch(`/api/antigravity-accounts/${id}`, {
        status: status === "disabled" ? "active" : "disabled",
      });
      const d = await api.get<{ accounts: AntigravityAccount[] }>("/api/antigravity-accounts");
      setAccounts(d.accounts);
    } catch (e) {
      setPanelError((e as Error).message || "Could not change the account");
    } finally {
      setTogglingId(null);
    }
  }, []);

  const hasBuckets = Boolean(usage.session || usage.weekly || usage.weeklyScoped?.length);
  const ambient = loading && accounts.length === 0 ? (
    <div className="text-xs text-text-subtle flex items-center gap-2">
      <Loader2 className="size-3 animate-spin" /> Loading…
    </div>
  ) : (
    <AccountCardShell active={true}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text-primary truncate flex-1 min-w-0">
          {usage.activeAccountLabel || "Antigravity Desktop"}
        </span>
        {usage.activeAccountId && (
          <span className="text-[10px] text-text-subtle border border-border rounded px-1.5 py-0.5 truncate max-w-[180px]">
            {usage.activeAccountId}
          </span>
        )}
      </div>
      <div className="space-y-2">
        <AccountBucketRow label="Gemini · 5-Hour" bucket={usage.session} />
        <AccountBucketRow label="Gemini · Weekly" bucket={usage.weekly} />
        {usage.weeklyScoped?.map((b) => (
          <AccountBucketRow key={b.label} label={b.label} bucket={b} />
        ))}
        {!hasBuckets && (
          <p className="text-xs text-text-subtle">
            {parentLoading || loading
              ? "Loading quota from Antigravity Language Server…"
              : panelError
                ? panelError
                : "No quota data available"}
          </p>
        )}
      </div>
    </AccountCardShell>
  );

  return (
    <UsagePanelShell
      title="Antigravity Usage"
      meta={lastFetchedAt ? (
        <span className="text-[10px] text-text-subtle">
          {formatLastUpdated(new Date(lastFetchedAt).getTime())}
        </span>
      ) : undefined}
      onClose={onClose}
      onReload={onReload ? () => void reload() : undefined}
      reloading={Boolean(parentLoading || loading)}
      error={panelError}
      onDismissError={() => setPanelError(null)}
      cardCount={accounts.length}
      fallback={ambient}
    >
      {(layout) =>
        accounts.map((a) => {
          const u = usages[a.id] ?? {};
          const activeId = selectedAccountId ?? usage.activeAccountId;
          const isActive = a.id === activeId || (a.email != null && a.email === activeId);
          return (
            <AccountCard
              key={a.id}
              entry={toEntry(a, u)}
              isActive={isActive}
              layout={layout}
              planLabel={a.planType}
              onSelect={onSelectAccount ? handleSelect : undefined}
              unselectableReason={unselectableReason(a, u)}
              selecting={selectingId === a.id}
              onToggle={handleToggle}
              toggling={togglingId === a.id}
            />
          );
        })
      }
    </UsagePanelShell>
  );
}
