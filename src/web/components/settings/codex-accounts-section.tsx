import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import { Trash2, Loader2, KeyRound, MonitorSmartphone, ExternalLink } from "lucide-react";

type Strategy = "round-robin" | "fill-first" | "lowest-usage";
interface CodexAccount { id: string; label: string; type: string; planType?: string | null }
interface Usage { fiveHour?: number; sevenDay?: number }
interface DevicePending { id: string; userCode: string; verificationUrl: string }

const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: "round-robin", label: "Round-robin" },
  { value: "fill-first", label: "Fill-first" },
  { value: "lowest-usage", label: "Lowest usage" },
];

function pct(v?: number): string { return v != null ? `${Math.round(v * 100)}%` : "—"; }

/** Codex multi-account management (separate from Claude accounts — codex auth is
 * owned by the app-server per CODEX_HOME). Add via API key or ChatGPT device-code. */
export function CodexAccountsSection() {
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [strategy, setStrategy] = useState<Strategy>("round-robin");
  const [usages, setUsages] = useState<Record<string, Usage>>({});
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [device, setDevice] = useState<DevicePending | null>(null);
  const [deviceWaiting, setDeviceWaiting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ accounts: CodexAccount[]; strategy: Strategy }>("/api/codex-accounts");
      setAccounts(d.accounts);
      setStrategy(d.strategy);
      api.get<Record<string, Usage>>("/api/codex-accounts/usage").then(setUsages).catch(() => {});
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const addApiKey = async () => {
    if (!apiKey.trim()) return;
    setAdding(true); setErr(null);
    try {
      await api.post("/api/codex-accounts/api-key", { apiKey: apiKey.trim(), label: label.trim() || undefined });
      setApiKey(""); setLabel(""); await load();
    } catch (e) { setErr((e as Error).message); } finally { setAdding(false); }
  };

  const startDevice = async () => {
    setErr(null);
    try {
      const d = await api.post<DevicePending>("/api/codex-accounts/device-login", { label: label.trim() || undefined });
      setDevice(d); setDeviceWaiting(true);
      api.post(`/api/codex-accounts/device-login/${d.id}/await`)
        .then(async () => { setDevice(null); setDeviceWaiting(false); setLabel(""); await load(); })
        .catch((e) => { setErr((e as Error).message); setDevice(null); setDeviceWaiting(false); });
    } catch (e) { setErr((e as Error).message); }
  };

  const remove = async (id: string) => { await api.del(`/api/codex-accounts/${id}`); await load(); };
  const changeStrategy = async (s: Strategy) => { setStrategy(s); try { await api.put("/api/codex-accounts/strategy", { strategy: s }); } catch { /* revert on reload */ } };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Codex Accounts</h3>
        <p className="text-xs text-text-subtle mt-0.5">Each account uses its own login (CODEX_HOME). One is selected per chat by the strategy below.</p>
      </div>

      {err && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-md p-2">{err}</div>}

      {/* Strategy */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-secondary">Selection strategy:</span>
        {STRATEGIES.map((s) => (
          <button key={s.value} type="button" onClick={() => changeStrategy(s.value)}
            className={`text-xs px-3 min-h-[36px] rounded-md border transition-colors ${strategy === s.value ? "border-primary bg-primary/15 text-text-primary" : "border-border bg-surface/50 text-text-secondary hover:bg-surface"}`}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Account list */}
      <div className="space-y-2">
        {loading && accounts.length === 0 && <div className="text-xs text-text-subtle flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>}
        {!loading && accounts.length === 0 && <div className="text-xs text-text-subtle">No codex accounts yet — add one below. (With none, chats use your default <code>~/.codex</code> login.)</div>}
        {accounts.map((a) => {
          const u = usages[a.id] ?? {};
          return (
            <div key={a.id} className="flex items-center gap-3 border border-border rounded-md bg-surface/40 p-2.5">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-primary truncate">{a.label}</span>
                  <span className="text-[10px] uppercase tracking-wide text-text-subtle border border-border rounded px-1">{a.type}</span>
                  {a.planType && <span className="text-[10px] text-text-subtle">{a.planType}</span>}
                </div>
                <div className="text-[11px] text-text-subtle mt-0.5">5h {pct(u.fiveHour)} · weekly {pct(u.sevenDay)}</div>
              </div>
              <button type="button" onClick={() => remove(a.id)} title="Remove account"
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-text-subtle hover:text-red-400 transition-colors">
                <Trash2 className="size-4" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Add */}
      <div className="border border-border rounded-md p-3 space-y-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)"
          className="w-full text-sm bg-surface border border-border rounded-md px-3 min-h-[40px] text-text-primary placeholder:text-text-subtle" />
        <div className="flex gap-2 flex-col sm:flex-row">
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="OpenAI API key (sk-…)"
            className="flex-1 text-sm bg-surface border border-border rounded-md px-3 min-h-[44px] text-text-primary placeholder:text-text-subtle font-mono" />
          <button type="button" onClick={addApiKey} disabled={adding || !apiKey.trim()}
            className="inline-flex items-center justify-center gap-2 text-sm px-4 min-h-[44px] rounded-md border border-border bg-surface/50 hover:bg-surface text-text-primary disabled:opacity-60">
            {adding ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} Add key
          </button>
        </div>
        <button type="button" onClick={startDevice} disabled={deviceWaiting}
          className="inline-flex items-center justify-center gap-2 text-sm px-4 min-h-[44px] w-full sm:w-auto rounded-md border border-border bg-surface/50 hover:bg-surface text-text-primary disabled:opacity-60">
          {deviceWaiting ? <Loader2 className="size-4 animate-spin" /> : <MonitorSmartphone className="size-4" />} Sign in with ChatGPT (device code)
        </button>
      </div>

      {/* Device-code prompt */}
      {device && (
        <div className="border border-primary/40 bg-primary/10 rounded-md p-3 space-y-2 text-sm">
          <p className="text-text-primary">Enter this code to authorize:</p>
          <div className="font-mono text-lg tracking-widest text-text-primary">{device.userCode}</div>
          <a href={device.verificationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline text-xs">
            <ExternalLink className="size-3" /> {device.verificationUrl}
          </a>
          <p className="text-xs text-text-subtle flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Waiting for authorization…</p>
        </div>
      )}
    </div>
  );
}
