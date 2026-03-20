import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  getAccounts,
  getActiveAccount,
  addAccount,
  deleteAccount,
  patchAccount,
  getAccountSettings,
  updateAccountSettings,
  getAllAccountUsages,
  type AccountInfo,
  type AccountSettings,
  type AccountUsageEntry,
} from "../../lib/api-settings";

function detectTokenType(token: string): string {
  if (token.startsWith("sk-ant-oat")) return "OAuth token (Claude Max/Pro)";
  if (token.startsWith("sk-ant-api")) return "API key";
  return "Unknown format";
}

function miniBarColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-green-500";
}

function miniPctColor(pct: number): string {
  if (pct >= 90) return "text-red-500";
  if (pct >= 70) return "text-amber-500";
  return "text-green-500";
}

function MiniBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] text-muted-foreground w-5 shrink-0">{label}</span>
      <div className="w-12 h-1.5 rounded-full bg-border overflow-hidden">
        <div className={`h-full rounded-full ${miniBarColor(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={`text-[9px] tabular-nums w-7 ${miniPctColor(pct)}`}>{pct}%</span>
    </div>
  );
}

function CompactUsageBars({ usage }: { usage: AccountUsageEntry["usage"] }) {
  if (!usage.session && !usage.weekly) return null;
  return (
    <div className="flex flex-col gap-0.5 mt-1">
      {usage.session && <MiniBar label="5h" value={usage.session.utilization} />}
      {usage.weekly && <MiniBar label="Wk" value={usage.weekly.utilization} />}
    </div>
  );
}

export function AccountsSettingsSection() {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [usageMap, setUsageMap] = useState<Map<string, AccountUsageEntry["usage"]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const [accs, cfg, active, usages] = await Promise.all([
        getAccounts(), getAccountSettings(), getActiveAccount(), getAllAccountUsages(),
      ]);
      setAccounts(accs);
      setSettings(cfg);
      setActiveAccountId(active?.id ?? null);
      setUsageMap(new Map(usages.map((u) => [u.accountId, u.usage])));
    } catch {
      // ignore
    }
    setLoading(false);
  }

  async function handleAddAccount() {
    if (!newToken.trim()) return;
    setAdding(true);
    try {
      await addAccount({ apiKey: newToken.trim(), label: newLabel.trim() || undefined });
      setMessage({ type: "success", text: "Account added successfully!" });
      setShowAddDialog(false);
      setNewToken("");
      setNewLabel("");
      refresh();
    } catch (e) {
      setMessage({ type: "error", text: (e as Error).message });
    }
    setAdding(false);
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
        setMessage({ type: "success", text: `Imported ${json.data?.imported ?? 0} account(s).` });
        refresh();
      } else {
        setMessage({ type: "error", text: json.error ?? "Import failed" });
      }
    } catch {
      setMessage({ type: "error", text: "Import failed" });
    }
    e.target.value = "";
  }

  const tokenHint = newToken.trim() ? detectTokenType(newToken.trim()) : "";

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] text-muted-foreground mb-3">
          Connect multiple Claude accounts. PPM rotates between them automatically to avoid rate limits.
        </p>

        {message && (
          <div className={`text-[11px] mb-3 p-2 rounded ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
            {message.text}
          </div>
        )}

        <div className="space-y-1.5 mb-3">
          {loading && <p className="text-[11px] text-muted-foreground">Loading...</p>}
          {!loading && accounts.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No accounts connected.</p>
          )}
          {accounts.map((acc) => (
            <div key={acc.id} className={`flex items-center justify-between p-2.5 rounded-lg border bg-card gap-2 ${acc.id === activeAccountId ? "ring-1 ring-primary/50 border-primary/30" : ""}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium truncate">{acc.label ?? acc.email ?? acc.id.slice(0, 8)}</span>
                  {statusBadge(acc)}
                  {acc.id === activeAccountId && <Badge variant="outline" className="text-[9px] px-1 py-0 border-primary/40 text-primary">In use</Badge>}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5 flex gap-2 flex-wrap">
                  {acc.email && acc.label && <span>{acc.email}</span>}
                  <span>{acc.totalRequests} reqs</span>
                  <span>Last: {formatLastUsed(acc.lastUsedAt)}</span>
                </div>
                {usageMap.get(acc.id) && <CompactUsageBars usage={usageMap.get(acc.id)!} />}
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
          <Button size="sm" className="h-7 text-xs" onClick={() => setShowAddDialog(true)}>
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

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Add Claude Account</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Supports both Claude Max/Pro session tokens and API keys. Token is encrypted and stored locally.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="token" className="text-xs">Token</Label>
              <Input
                id="token"
                type="password"
                placeholder="sk-ant-..."
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                className="text-xs h-8 font-mono"
              />
              {tokenHint && (
                <p className="text-[10px] text-muted-foreground">
                  Detected: {tokenHint}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="label" className="text-xs">Label (optional)</Label>
              <Input
                id="label"
                placeholder="e.g. Personal, Work"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                className="text-xs h-8"
              />
            </div>
            <div className="rounded-md bg-muted/50 p-2.5 space-y-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">How to get your token:</p>
              <div className="text-[10px] text-muted-foreground space-y-1">
                <p><span className="font-medium">Claude Max/Pro:</span> Run in terminal:</p>
                <code className="block bg-background rounded px-1.5 py-1 text-[10px] font-mono select-all">
                  claude setup-token
                </code>
                <p className="text-[9px]">Follow the prompts to generate a long-lived token (valid for 1 year).</p>
                <p className="mt-1"><span className="font-medium">API key:</span>{" "}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline hover:no-underline"
                  >
                    console.anthropic.com/settings/keys
                  </a>
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => setShowAddDialog(false)}>
              Cancel
            </Button>
            <Button size="sm" className="text-xs h-7" onClick={handleAddAccount} disabled={!newToken.trim() || adding}>
              {adding ? "Adding..." : "Add Account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
