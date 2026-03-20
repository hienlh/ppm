import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  getAccounts,
  deleteAccount,
  patchAccount,
  getAccountSettings,
  updateAccountSettings,
  type AccountInfo,
  type AccountSettings,
} from "../../lib/api-settings";

export function AccountsSettingsSection() {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [oauthMessage, setOauthMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Detect OAuth callback result from URL hash params
  useEffect(() => {
    const hash = window.location.hash;
    const qIndex = hash.indexOf("?");
    if (qIndex === -1) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    if (params.get("success")) {
      setOauthMessage({ type: "success", text: "Account connected successfully!" });
      window.history.replaceState(null, "", window.location.pathname + hash.slice(0, qIndex));
    } else if (params.get("error")) {
      setOauthMessage({ type: "error", text: `OAuth failed: ${params.get("error")}` });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const [accs, cfg] = await Promise.all([getAccounts(), getAccountSettings()]);
      setAccounts(accs);
      setSettings(cfg);
    } catch {
      // ignore
    }
    setLoading(false);
  }

  function handleAddAccount() {
    window.location.href = "/api/accounts/oauth/start";
  }

  async function handleToggle(id: string, currentStatus: string) {
    const newStatus = currentStatus === "disabled" ? "active" : "disabled";
    await patchAccount(id, { status: newStatus });
    refresh();
  }

  async function handleDelete(id: string, email: string | null) {
    if (!confirm(`Remove account ${email ?? id}?`)) return;
    await deleteAccount(id);
    refresh();
  }

  function formatLastUsed(ts: number | null): string {
    if (!ts) return "Never";
    const diff = Math.floor(Date.now() / 1000 - ts);
    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function formatCooldown(cooldownUntil: number | null): string {
    if (!cooldownUntil) return "";
    const remaining = cooldownUntil - Math.floor(Date.now() / 1000);
    if (remaining <= 0) return "";
    if (remaining < 60) return `${remaining}s`;
    return `${Math.floor(remaining / 60)}m ${remaining % 60}s`;
  }

  function statusBadge(acc: AccountInfo) {
    if (acc.status === "active") return <Badge variant="default" className="text-[10px] px-1.5 py-0">Active</Badge>;
    if (acc.status === "disabled") return <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Disabled</Badge>;
    const cd = formatCooldown(acc.cooldownUntil);
    return <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Cooldown{cd ? ` (${cd})` : ""}</Badge>;
  }

  async function handleExport() {
    window.location.href = "/api/accounts/export";
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const res = await fetch("/api/accounts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      const json = await res.json() as { ok: boolean; data?: { imported: number }; error?: string };
      if (json.ok) {
        setOauthMessage({ type: "success", text: `Imported ${json.data?.imported ?? 0} account(s).` });
        refresh();
      } else {
        setOauthMessage({ type: "error", text: json.error ?? "Import failed" });
      }
    } catch {
      setOauthMessage({ type: "error", text: "Import failed" });
    }
    e.target.value = "";
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] text-muted-foreground mb-3">
          Connect multiple Claude Pro/Max accounts. PPM rotates between them automatically to avoid rate limits.
        </p>

        {oauthMessage && (
          <div className={`text-[11px] mb-3 p-2 rounded ${oauthMessage.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
            {oauthMessage.text}
          </div>
        )}

        <div className="space-y-1.5 mb-3">
          {loading && <p className="text-[11px] text-muted-foreground">Loading...</p>}
          {!loading && accounts.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No accounts connected.</p>
          )}
          {accounts.map((acc) => (
            <div key={acc.id} className="flex items-center justify-between p-2.5 rounded-lg border bg-card gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium truncate">{acc.email ?? acc.id.slice(0, 8)}</span>
                  {statusBadge(acc)}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5 flex gap-2">
                  <span>{acc.totalRequests} reqs</span>
                  <span>Last: {formatLastUsed(acc.lastUsedAt)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Switch
                  checked={acc.status !== "disabled"}
                  onCheckedChange={() => handleToggle(acc.id, acc.status)}
                  disabled={acc.status === "cooldown"}
                  className="scale-75"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(acc.id, acc.email)}
                >
                  ✕
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-1.5 flex-wrap">
          <Button size="sm" className="h-7 text-xs" onClick={handleAddAccount}>
            + Add Account
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleExport}>
            Export
          </Button>
          <label>
            <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
              <span>Import</span>
            </Button>
            <input type="file" accept=".json" className="hidden" onChange={handleImport} />
          </label>
        </div>
      </div>

      {settings && (
        <div className="border-t pt-3 space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground">Rotation Settings</p>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground w-20 shrink-0">Strategy</label>
            <Select
              value={settings.strategy}
              onValueChange={async (v) => {
                const updated = await updateAccountSettings({ strategy: v as "round-robin" | "fill-first" });
                setSettings(updated);
              }}
            >
              <SelectTrigger className="w-32 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="round-robin">Round-robin</SelectItem>
                <SelectItem value="fill-first">Fill-first</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground w-20 shrink-0">Max retry</label>
            <input
              type="number"
              min={0}
              value={settings.maxRetry}
              className="w-14 h-7 text-xs border rounded px-2 bg-background"
              onChange={async (e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 0) {
                  const updated = await updateAccountSettings({ maxRetry: v });
                  setSettings(updated);
                }
              }}
            />
            <span className="text-[11px] text-muted-foreground">(0 = try all)</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Active accounts: {settings.activeCount}
          </p>
        </div>
      )}
    </div>
  );
}
