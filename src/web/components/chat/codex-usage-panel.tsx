import { useState, useEffect, useCallback } from "react";
import { X, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountUsageBar } from "@/components/settings/accounts/account-bucket-row";
import { formatResetTime } from "@/components/settings/accounts/account-usage-format";
import type { UsageInfo } from "../../../types/chat";

interface CodexAccount { id: string; label: string; type: string; planType?: string | null; status?: "active" | "disabled" }
type Usage = Pick<UsageInfo, "fiveHour" | "sevenDay" | "session" | "weekly">;

/** Matches the whole-percent figure the bars show, so a refusal agrees with the card. */
function atCap(util: number | null | undefined): boolean {
  return Math.round((util ?? 0) * 100) >= 100;
}

function UsageBar({ label, frac, bucket }: {
  label: string;
  frac?: number;
  bucket?: UsageInfo["session"];
}) {
  const pct = frac != null ? Math.round(frac * 100) : null;
  return <AccountUsageBar label={label} pct={pct} reset={formatResetTime(bucket)} resetsAt={bucket?.resetsAt} />;
}

/** Read-only usage panel opened from the chat toolbar badge (Claude parity).
 * Shows every managed Codex account's 5h/weekly utilization. When no managed
 * accounts exist, chats run on the ambient ~/.codex login — its usage comes
 * from the session `usage` prop. Login/management lives in Settings → AI
 * Provider → Codex. */
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
  const [toggleError, setToggleError] = useState<string | null>(null);

  // This panel draws its own cards rather than reusing Settings' AccountCard, so the
  // selection control is rebuilt here. Kept visually the same as the Claude panel's on
  // purpose — the two sub-tabs drifting apart is the thing the shared Settings layout was
  // introduced to stop, and a differently-shaped button here would start it again.
  const select = useCallback(async (id: string, label: string, refused: string | null) => {
    if (!onSelectAccount) return;
    // Refuse here rather than leaving the button inert: the user pressed something and is
    // owed the reason. The server checks again, which catches an account that became
    // unusable between this render and the click.
    if (refused) { setToggleError(`Cannot switch to this account — ${refused}`); return; }
    setSelectingId(id);
    setToggleError(null);
    try { setToggleError((await onSelectAccount(id, label)) ?? null); } finally { setSelectingId(null); }
  }, [onSelectAccount]);

  /**
   * Switch a Codex account on or off without leaving the chat.
   *
   * No pending-token dance like the Claude side: the Codex route answers immediately because
   * there is no refresh token to prove. The pending id is still tracked so the switch cannot
   * be double-fired on a slow connection.
   */
  const toggle = useCallback(async (id: string, status: string) => {
    setTogglingId(id);
    setToggleError(null);
    try {
      await api.patch(`/api/codex-accounts/${id}`, { status: status === "disabled" ? "active" : "disabled" });
      const d = await api.get<{ accounts: CodexAccount[] }>("/api/codex-accounts");
      setAccounts(d.accounts);
    } catch (e) {
      setToggleError((e as Error).message || "Could not change the account");
    } finally {
      setTogglingId(null);
    }
  }, []);

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

  return (
    <div className="border-t border-border bg-surface px-3 py-2.5 space-y-2.5 max-h-[350px] overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-text-primary">Codex Usage</span>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={reload}
                disabled={loading}
                className="text-text-subtle hover:text-text-primary px-1 cursor-pointer disabled:opacity-50"
                aria-label="Refresh usage"
              >
                <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Refresh</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onClose}
                className="text-text-subtle hover:text-text-primary px-1 cursor-pointer"
                aria-label="Close usage panel"
              >
                <X className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Close</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {toggleError && (
        <div className="flex items-start gap-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 text-[11px] text-error">
          <span className="flex-1">{toggleError}</span>
          <button onClick={() => setToggleError(null)} className="shrink-0 text-error/70 hover:text-error cursor-pointer" aria-label="Dismiss">
            <X className="size-3" />
          </button>
        </div>
      )}

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
        const isServing = a.id === (selectedAccountId ?? usage.activeAccountId);
        // Reached, not approaching: an account at 96% still answers, one at 100% does not.
        const refused = a.status === "disabled"
          ? "it is switched off."
          : atCap(u.fiveHour)
            ? "it has reached its 5-hour limit."
            : atCap(u.sevenDay)
              ? "it has reached its weekly limit."
              : null;
        return (
          <div
            key={a.id}
            className={`rounded-md border bg-surface/40 p-2.5 space-y-2 ${isServing ? "border-primary/30 bg-primary/5" : "border-border/50"}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-primary truncate flex-1 min-w-0">{a.label}</span>
              {isServing && <span className="text-[10px] text-primary shrink-0 font-medium">Active</span>}
              {/* Same slot as the Active badge, so every card keeps one header row and the
                  panel does not grow taller just to carry a button. */}
              {onSelectAccount && !isServing && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => select(a.id, a.label, refused)}
                      disabled={selectingId === a.id}
                      className={[
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors cursor-pointer disabled:cursor-wait",
                        refused
                          ? "text-text-subtle hover:text-error hover:bg-error/10"
                          : "text-text-secondary hover:text-foreground hover:bg-surface-elevated",
                      ].join(" ")}
                    >
                      {selectingId === a.id ? "Switching…" : "Use"}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {refused ? `Cannot use this account — ${refused}` : "Use this account for this chat"}
                  </TooltipContent>
                </Tooltip>
              )}
              {a.status === "disabled" && <span className="text-[10px] text-text-subtle shrink-0">Off</span>}
              <span className="text-[10px] uppercase tracking-wide text-text-subtle border border-border rounded px-1">{a.type}</span>
              {a.planType && <span className="text-[10px] text-text-subtle">{a.planType}</span>}
              <Switch
                checked={a.status !== "disabled"}
                onCheckedChange={() => void toggle(a.id, a.status ?? "active")}
                disabled={togglingId === a.id}
                aria-label={a.status === "disabled" ? "Enable account" : "Disable account"}
                className="cursor-pointer shrink-0"
              />
            </div>
            <UsageBar label="5-Hour" frac={u.fiveHour} bucket={u.session} />
            <UsageBar label="Weekly" frac={u.sevenDay} bucket={u.weekly} />
          </div>
        );
      })}
    </div>
  );
}
