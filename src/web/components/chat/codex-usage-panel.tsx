import { useState, useEffect, useCallback } from "react";
import { X, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";
import { AccountUsageBar } from "@/components/settings/accounts/account-bucket-row";
import { formatResetTime } from "@/components/settings/accounts/account-usage-format";
import type { UsageInfo } from "../../../types/chat";

interface CodexAccount { id: string; label: string; type: string; planType?: string | null }
type Usage = Pick<UsageInfo, "fiveHour" | "sevenDay" | "session" | "weekly">;

function UsageBar({ label, frac, bucket }: {
  label: string;
  frac?: number;
  bucket?: UsageInfo["session"];
}) {
  const pct = frac != null ? Math.round(frac * 100) : null;
  return <AccountUsageBar label={label} pct={pct} reset={formatResetTime(bucket)} />;
}

/** Read-only usage panel opened from the chat toolbar badge (Claude parity).
 * Shows every managed Codex account's 5h/weekly utilization. When no managed
 * accounts exist, chats run on the ambient ~/.codex login — its usage comes
 * from the session `usage` prop. Login/management lives in Settings → AI
 * Provider → Codex. */
export function CodexUsagePanel({ onClose, usage }: { onClose: () => void; usage: UsageInfo }) {
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [usages, setUsages] = useState<Record<string, Usage>>({});
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="border-t border-border bg-surface px-3 py-2.5 space-y-2.5 max-h-[350px] overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-text-primary">Codex Usage</span>
        <div className="flex items-center gap-1">
          <button
            onClick={load}
            disabled={loading}
            className="text-text-subtle hover:text-text-primary px-1 cursor-pointer disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button onClick={onClose} className="text-text-subtle hover:text-text-primary px-1 cursor-pointer" title="Close">
            <X className="size-3" />
          </button>
        </div>
      </div>

      {loading && accounts.length === 0 && (
        <div className="text-xs text-text-subtle flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>
      )}

      {/* No managed accounts → chat runs on the ambient ~/.codex login; show its usage */}
      {!loading && accounts.length === 0 && (
        <>
          <div className="rounded-md border border-border/50 bg-surface/40 p-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-primary truncate flex-1 min-w-0">{usage.activeAccountLabel || "Default login"}</span>
              <span className="text-[10px] uppercase tracking-wide text-text-subtle border border-border rounded px-1">~/.codex</span>
            </div>
            <UsageBar label="5-Hour" frac={usage.fiveHour} bucket={usage.session} />
            <UsageBar label="Weekly" frac={usage.sevenDay} bucket={usage.weekly} />
          </div>
          <p className="text-[11px] text-text-subtle">Using your default <code>~/.codex</code> login. Add managed accounts in Settings → AI Provider → Codex.</p>
        </>
      )}

      {accounts.map((a) => {
        const u = usages[a.id] ?? {};
        return (
          <div key={a.id} className="rounded-md border border-border/50 bg-surface/40 p-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-primary truncate flex-1 min-w-0">{a.label}</span>
              <span className="text-[10px] uppercase tracking-wide text-text-subtle border border-border rounded px-1">{a.type}</span>
              {a.planType && <span className="text-[10px] text-text-subtle">{a.planType}</span>}
            </div>
            <UsageBar label="5-Hour" frac={u.fiveHour} bucket={u.session} />
            <UsageBar label="Weekly" frac={u.sevenDay} bucket={u.weekly} />
          </div>
        );
      })}
    </div>
  );
}
