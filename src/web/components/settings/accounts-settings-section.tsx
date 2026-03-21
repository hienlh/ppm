import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Eye, Loader2, Copy, ClipboardPaste, X, MoreHorizontal, Download, Upload } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getAuthToken } from "../../lib/api-client";
import {
  getAccounts,
  getActiveAccount,
  addAccount,
  deleteAccount,
  patchAccount,
  getOAuthUrl,
  exchangeOAuthCode,
  getAccountSettings,
  updateAccountSettings,
  getAllAccountUsages,
  type AccountInfo,
  type AccountSettings,
  type AccountUsageEntry,
  type OAuthProfileData,
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

function subscriptionLabel(profile: OAuthProfileData): string {
  const org = profile.organization;
  if (!org) return "";
  const type = org.organization_type?.replace(/_/g, " ") ?? "";
  const tier = org.rate_limit_tier?.replace(/^default_/, "").replace(/_/g, " ") ?? "";
  return [type, tier].filter(Boolean).join(" / ");
}

function ProfileDetailDialog({ profile, open, onClose }: { profile: OAuthProfileData; open: boolean; onClose: () => void }) {
  const acc = profile.account;
  const org = profile.organization;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Account Profile</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          {acc && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">User</p>
              <div className="grid grid-cols-[80px_1fr] gap-1 text-xs">
                {acc.display_name && <><span className="text-muted-foreground">Name</span><span>{acc.display_name}</span></>}
                {acc.email && <><span className="text-muted-foreground">Email</span><span>{acc.email}</span></>}
                {acc.uuid && <><span className="text-muted-foreground">UUID</span><span className="font-mono text-[10px] break-all">{acc.uuid}</span></>}
              </div>
            </div>
          )}
          {org && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">Organization</p>
              <div className="grid grid-cols-[80px_1fr] gap-1 text-xs">
                {org.name && <><span className="text-muted-foreground">Name</span><span>{org.name}</span></>}
                {org.organization_type && <><span className="text-muted-foreground">Type</span><span>{org.organization_type}</span></>}
                {org.rate_limit_tier && <><span className="text-muted-foreground">Tier</span><span>{org.rate_limit_tier}</span></>}
                {org.subscription_status && <><span className="text-muted-foreground">Status</span><span>{org.subscription_status}</span></>}
                {org.has_extra_usage_enabled !== undefined && <><span className="text-muted-foreground">Extra usage</span><span>{org.has_extra_usage_enabled ? "Enabled" : "Disabled"}</span></>}
              </div>
            </div>
          )}
          {!acc && !org && <p className="text-muted-foreground">No profile data available.</p>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AccountsSettingsSection() {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [usageMap, setUsageMap] = useState<Map<string, AccountUsageEntry["usage"]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const msgTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  function showMessage(msg: { type: "success" | "error"; text: string }) {
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    setMessage(msg);
    msgTimerRef.current = setTimeout(() => setMessage(null), 4000);
  }
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [profileView, setProfileView] = useState<OAuthProfileData | null>(null);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthStep, setOauthStep] = useState<"idle" | "waiting">("idle");

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    const [accs, cfg, active, usages] = await Promise.allSettled([
      getAccounts(), getAccountSettings(), getActiveAccount(), getAllAccountUsages(),
    ]);
    if (accs.status === "fulfilled") setAccounts(accs.value);
    if (cfg.status === "fulfilled") setSettings(cfg.value);
    if (active.status === "fulfilled") setActiveAccountId(active.value?.id ?? null);
    if (usages.status === "fulfilled") setUsageMap(new Map(usages.value.map((u) => [u.accountId, u.usage])));
    setLoading(false);
  }

  async function handleAddAccount() {
    if (!newToken.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await addAccount({ apiKey: newToken.trim(), label: newLabel.trim() || undefined });
      showMessage({ type: "success", text: "Account added successfully!" });
      setShowAddDialog(false);
      setNewToken("");
      setNewLabel("");
      setAddError(null);
      refresh();
    } catch (e) {
      setAddError((e as Error).message);
    }
    setAdding(false);
  }

  async function handleOAuthLogin() {
    setOauthLoading(true);
    setAddError(null);
    try {
      const { url, state } = await getOAuthUrl();
      setOauthState(state);
      setOauthStep("waiting");
      window.open(url, "_blank");
    } catch (e) {
      setAddError((e as Error).message);
    }
    setOauthLoading(false);
  }

  async function handleOAuthExchange() {
    if (!oauthCode.trim() || !oauthState) return;
    setOauthLoading(true);
    setAddError(null);
    try {
      // Parse code — platform returns "CODE#STATE" or just the code
      let code = oauthCode.trim();
      if (code.includes("#")) code = code.split("#")[0];
      await exchangeOAuthCode(code, oauthState);
      showMessage({ type: "success", text: "Account connected via OAuth!" });
      setShowAddDialog(false);
      resetOAuthState();
      refresh();
    } catch (e) {
      setAddError((e as Error).message);
    }
    setOauthLoading(false);
  }

  function resetOAuthState() {
    setOauthState(null);
    setOauthCode("");
    setOauthStep("idle");
    setAddError(null);
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
    try {
      const headers: HeadersInit = {};
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/accounts/export", { headers });
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ppm-accounts-backup.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      showMessage({ type: "error", text: (e as Error).message });
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const headers: HeadersInit = { "Content-Type": "application/json" };
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/accounts/import", { method: "POST", headers, body: text });
      const json = await res.json() as { ok: boolean; data?: { imported: number }; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Import failed");
      showMessage({ type: "success", text: `Imported ${json.data?.imported ?? 0} account(s).` });
      refresh();
    } catch (e) {
      showMessage({ type: "error", text: (e as Error).message || "Import failed" });
    }
    e.target.value = "";
  }

  async function handleExportClipboard() {
    try {
      const headers: HeadersInit = {};
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/accounts/export", { headers });
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      showMessage({ type: "success", text: "Accounts copied to clipboard!" });
    } catch (e) {
      showMessage({ type: "error", text: (e as Error).message });
    }
  }

  async function handleImportClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error("Clipboard is empty");
      JSON.parse(text); // validate JSON
      const headers: HeadersInit = { "Content-Type": "application/json" };
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/accounts/import", { method: "POST", headers, body: text });
      const json = await res.json() as { ok: boolean; data?: { imported: number }; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Import failed");
      showMessage({ type: "success", text: `Imported ${json.data?.imported ?? 0} account(s) from clipboard.` });
      refresh();
    } catch (e) {
      showMessage({ type: "error", text: (e as Error).message || "Import from clipboard failed" });
    }
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
                  {acc.profileData?.organization?.name && (
                    <span>{subscriptionLabel(acc.profileData)}</span>
                  )}
                  <span>{acc.totalRequests} reqs</span>
                  <span>Last: {formatLastUsed(acc.lastUsedAt)}</span>
                </div>
                {usageMap.get(acc.id) && <CompactUsageBars usage={usageMap.get(acc.id)!} />}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {acc.profileData && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => setProfileView(acc.profileData)}
                    title="View profile"
                  >
                    <Eye className="size-3.5" />
                  </Button>
                )}
                <Switch
                  checked={acc.status !== "disabled"}
                  onCheckedChange={() => handleToggle(acc.id, acc.status)}
                  disabled={acc.status === "cooldown"}
                  className="scale-75 cursor-pointer"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 cursor-pointer text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(acc.id, acc.email)}
                  title="Remove account"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-1.5">
          <Button size="sm" className="h-8 text-xs cursor-pointer" onClick={() => setShowAddDialog(true)}>
            + Add Account
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 text-xs cursor-pointer">
                <MoreHorizontal className="size-3.5 mr-1" /> More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem className="text-xs cursor-pointer" onClick={handleExportClipboard}>
                <Copy className="size-3.5 mr-2" /> Copy to clipboard
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs cursor-pointer" onClick={handleImportClipboard}>
                <ClipboardPaste className="size-3.5 mr-2" /> Paste from clipboard
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs cursor-pointer" onClick={handleExport}>
                <Download className="size-3.5 mr-2" /> Export as file
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs cursor-pointer" asChild>
                <label className="flex items-center">
                  <Upload className="size-3.5 mr-2" /> Import from file
                  <input type="file" accept=".json" className="hidden" onChange={handleImport} />
                </label>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

      {/* Profile detail dialog */}
      {profileView && (
        <ProfileDetailDialog
          profile={profileView}
          open={!!profileView}
          onClose={() => setProfileView(null)}
        />
      )}

      <Dialog open={showAddDialog} onOpenChange={(v) => { setShowAddDialog(v); if (!v) resetOAuthState(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Add Claude Account</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Connect your Claude account via OAuth (recommended) or paste a token manually.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/* OAuth login — recommended */}
            <div className="rounded-md border p-3 space-y-2">
              <p className="text-[11px] font-medium">Recommended: Login with Claude</p>
              <p className="text-[10px] text-muted-foreground">
                Fetches your profile, enables auto-refresh, and uses the correct permissions.
              </p>
              {oauthStep === "idle" ? (
                <Button
                  size="sm"
                  className="w-full h-8 text-xs"
                  onClick={handleOAuthLogin}
                  disabled={oauthLoading}
                >
                  {oauthLoading ? <><Loader2 className="size-3 animate-spin mr-1" /> Opening...</> : "Login with Claude"}
                </Button>
              ) : (
                <div className="space-y-2">
                  <p className="text-[10px] text-muted-foreground">
                    Authorize in the opened tab, then paste the code shown on the page:
                  </p>
                  <Input
                    placeholder="Paste code here..."
                    value={oauthCode}
                    onChange={(e) => setOauthCode(e.target.value)}
                    className="text-xs h-8 font-mono"
                    autoFocus
                  />
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      className="flex-1 h-7 text-xs"
                      onClick={handleOAuthExchange}
                      disabled={!oauthCode.trim() || oauthLoading}
                    >
                      {oauthLoading ? <><Loader2 className="size-3 animate-spin mr-1" /> Connecting...</> : "Connect Account"}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={resetOAuthState}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div className="flex-1 border-t" />
              <span className="text-[10px] text-muted-foreground">or paste token manually</span>
              <div className="flex-1 border-t" />
            </div>

            {/* Manual token input */}
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
              <p className="text-[10px] font-medium text-muted-foreground">How to get a token manually:</p>
              <div className="text-[10px] text-muted-foreground space-y-1">
                <p><span className="font-medium">Claude Max/Pro:</span> Run <code className="bg-background rounded px-1 font-mono">claude setup-token</code></p>
                <p className="text-[9px]">Valid 1 year but no auto-refresh, may lack profile data.</p>
                <p><span className="font-medium">API key:</span>{" "}
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
          {addError && (
            <div className="text-[11px] p-2 rounded bg-red-500/10 text-red-600">
              {addError}
            </div>
          )}
          <DialogFooter>
            <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => { setShowAddDialog(false); resetOAuthState(); }}>
              Cancel
            </Button>
            <Button size="sm" className="text-xs h-7" onClick={handleAddAccount} disabled={!newToken.trim() || adding}>
              {adding ? "Adding..." : "Add Token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
