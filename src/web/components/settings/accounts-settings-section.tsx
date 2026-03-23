import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Eye, Loader2, Copy, X, Download, Upload, Lock } from "lucide-react";
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
  importAccounts,
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
  // Export dialog
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirm, setExportConfirm] = useState("");
  const [exportSelected, setExportSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  // Import dialog
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [importData, setImportData] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

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
      if (code.includes("#")) code = code.split("#")[0] ?? code;
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
    if (acc.status === "active" || acc.status === "disabled") return null;
    const cd = formatCooldown(acc.cooldownUntil);
    return <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Cooldown{cd ? ` (${cd})` : ""}</Badge>;
  }

  function openExportDialog() {
    setExportPassword("");
    setExportConfirm("");
    setExportSelected(new Set(accounts.map((a) => a.id)));
    setShowExportDialog(true);
  }

  function openImportDialog(prefillData?: string) {
    setImportPassword("");
    setImportData(prefillData ?? "");
    setImportError(null);
    setShowImportDialog(true);
  }

  async function doExport(toClipboard: boolean) {
    if (exportPassword.length < 4) return;
    if (exportPassword !== exportConfirm) return;
    setExporting(true);
    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/accounts/export", {
        method: "POST",
        headers,
        body: JSON.stringify({ password: exportPassword, accountIds: [...exportSelected] }),
      });
      if (!res.ok) { const j = await res.json() as any; throw new Error(j.error ?? `Export failed: ${res.status}`); }
      const text = await res.text();
      if (toClipboard) {
        try {
          await navigator.clipboard.writeText(text);
          showMessage({ type: "success", text: "Backup copied to clipboard!" });
        } catch {
          const blob = new Blob([text], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "ppm-accounts-backup.json";
          a.click();
          URL.revokeObjectURL(a.href);
          showMessage({ type: "success", text: "Clipboard unavailable — downloaded as file." });
        }
      } else {
        const blob = new Blob([text], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "ppm-accounts-backup.json";
        a.click();
        URL.revokeObjectURL(a.href);
        showMessage({ type: "success", text: "Backup downloaded." });
      }
      setShowExportDialog(false);
    } catch (e) {
      showMessage({ type: "error", text: (e as Error).message });
    }
    setExporting(false);
  }

  async function doImport() {
    if (!importData.trim() || !importPassword) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await importAccounts({ data: importData.trim(), password: importPassword });
      showMessage({ type: "success", text: `Imported ${result.imported} account(s).` });
      setShowImportDialog(false);
      refresh();
    } catch (e) {
      setImportError((e as Error).message || "Import failed");
    }
    setImporting(false);
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
          {accounts.map((acc) => {
            const usage = usageMap.get(acc.id);
            return (
              <div key={acc.id} className="p-2.5 rounded-lg border bg-card space-y-1.5">
                {/* Row 1: name + badges + actions */}
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="text-xs font-medium truncate">{acc.label ?? acc.email ?? acc.id.slice(0, 8)}</span>
                    {statusBadge(acc)}
                  </div>
                  <div className="flex items-center shrink-0">
                    {acc.profileData && (
                      <Button size="icon" variant="ghost" className="size-7 cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => setProfileView(acc.profileData)} title="View profile">
                        <Eye className="size-3" />
                      </Button>
                    )}
                    <Switch checked={acc.status !== "disabled"} onCheckedChange={() => handleToggle(acc.id, acc.status)} disabled={acc.status === "cooldown"} className="scale-[0.65] cursor-pointer" />
                    <Button size="icon" variant="ghost" className="size-7 cursor-pointer text-muted-foreground hover:text-destructive" onClick={() => handleDelete(acc.id, acc.email)} title="Remove">
                      <X className="size-3" />
                    </Button>
                  </div>
                </div>
                {/* Row 2: meta + usage inline */}
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <div className="flex gap-1.5 items-center min-w-0 truncate">
                    {acc.email && acc.label && <span className="truncate">{acc.email}</span>}
                    <span>{acc.totalRequests} req{acc.totalRequests !== 1 ? "s" : ""}</span>
                    <span>· {formatLastUsed(acc.lastUsedAt)}</span>
                  </div>
                  {usage && (usage.session || usage.weekly) && (
                    <div className="flex gap-2 shrink-0 tabular-nums">
                      {usage.session && <span className={miniPctColor(Math.round(usage.session.utilization * 100))}>5h {Math.round(usage.session.utilization * 100)}%</span>}
                      {usage.weekly && <span className={miniPctColor(Math.round(usage.weekly.utilization * 100))}>Wk {Math.round(usage.weekly.utilization * 100)}%</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <Button size="sm" className="h-8 text-xs cursor-pointer" onClick={() => setShowAddDialog(true)}>
            + Add
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs cursor-pointer" onClick={() => openExportDialog()}>
            <Download className="size-3.5 mr-1" /> Export
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs cursor-pointer" onClick={() => openImportDialog()}>
            <Upload className="size-3.5 mr-1" /> Import
          </Button>
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
                const updated = await updateAccountSettings({ strategy: v as "round-robin" | "fill-first" | "lowest-usage" });
                setSettings(updated);
              }}
            >
              <SelectTrigger className="w-32 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="round-robin">Round-robin</SelectItem>
                <SelectItem value="fill-first">Fill-first</SelectItem>
                <SelectItem value="lowest-usage">Lowest usage</SelectItem>
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

      {/* Export dialog — account selection + password */}
      <Dialog open={showExportDialog} onOpenChange={(v) => { if (!v) setShowExportDialog(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-1.5"><Lock className="size-3.5" /> Export Accounts</DialogTitle>
            <DialogDescription className="text-xs">Select accounts and set a password to protect the backup.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/* Account selection */}
            <div className="space-y-1">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[11px] font-medium text-muted-foreground">Accounts to export</p>
                <button
                  className="text-[10px] text-primary hover:underline cursor-pointer"
                  onClick={() => setExportSelected(
                    exportSelected.size === accounts.length ? new Set() : new Set(accounts.map((a) => a.id))
                  )}
                >
                  {exportSelected.size === accounts.length ? "Deselect all" : "Select all"}
                </button>
              </div>
              <div className="max-h-36 overflow-y-auto space-y-1 border rounded p-2">
                {accounts.map((acc) => (
                  <div key={acc.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`exp-${acc.id}`}
                      checked={exportSelected.has(acc.id)}
                      onChange={(e) => {
                        const s = new Set(exportSelected);
                        e.target.checked ? s.add(acc.id) : s.delete(acc.id);
                        setExportSelected(s);
                      }}
                      className="size-3.5 accent-primary cursor-pointer"
                    />
                    <label htmlFor={`exp-${acc.id}`} className="text-xs cursor-pointer truncate">
                      {acc.label ?? acc.email ?? acc.id.slice(0, 8)}
                      {acc.email && acc.label && <span className="text-muted-foreground ml-1 text-[10px]">({acc.email})</span>}
                    </label>
                  </div>
                ))}
              </div>
            </div>
            {/* Password */}
            <div className="space-y-1.5">
              <Label className="text-xs">Password</Label>
              <Input
                type="password"
                placeholder="Min 4 characters"
                value={exportPassword}
                onChange={(e) => setExportPassword(e.target.value)}
                className="text-xs h-8"
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Confirm password</Label>
              <Input
                type="password"
                placeholder="Re-enter password"
                value={exportConfirm}
                onChange={(e) => setExportConfirm(e.target.value)}
                className="text-xs h-8"
                autoComplete="new-password"
              />
              {exportConfirm && exportPassword !== exportConfirm && (
                <p className="text-[10px] text-red-500">Passwords do not match</p>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Encrypted with AES-256-GCM + scrypt. Keep the password safe — it cannot be recovered.
            </p>
          </div>
          <DialogFooter className="gap-1.5 flex-col sm:flex-row">
            <Button size="sm" variant="outline" className="text-xs h-7 cursor-pointer" onClick={() => setShowExportDialog(false)}>
              Cancel
            </Button>
            <Button
              size="sm" variant="outline" className="text-xs h-7 cursor-pointer"
              disabled={exportPassword.length < 4 || exportPassword !== exportConfirm || exportSelected.size === 0 || exporting}
              onClick={() => doExport(true)}
            >
              <Copy className="size-3 mr-1" /> Copy to clipboard
            </Button>
            <Button
              size="sm" className="text-xs h-7 cursor-pointer"
              disabled={exportPassword.length < 4 || exportPassword !== exportConfirm || exportSelected.size === 0 || exporting}
              onClick={() => doExport(false)}
            >
              {exporting ? <><Loader2 className="size-3 animate-spin mr-1" /> Exporting...</> : <><Download className="size-3 mr-1" /> Download</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import dialog — paste/file data + password */}
      <Dialog open={showImportDialog} onOpenChange={(v) => { if (!v) setShowImportDialog(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-1.5"><Lock className="size-3.5" /> Import Accounts</DialogTitle>
            <DialogDescription className="text-xs">Paste or load the backup data, then enter the password used during export.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Backup data</Label>
              <textarea
                value={importData}
                onChange={(e) => setImportData(e.target.value)}
                placeholder="Paste backup JSON here..."
                rows={4}
                className="w-full text-xs p-2 rounded border border-border bg-background font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Password</Label>
              <Input
                type="password"
                placeholder="Password used during export"
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                className="text-xs h-8"
                autoComplete="current-password"
              />
            </div>
          </div>
          {importError && (
            <div className="text-[11px] p-2 rounded bg-red-500/10 text-red-600">{importError}</div>
          )}
          <DialogFooter>
            <Button size="sm" variant="outline" className="text-xs h-7 cursor-pointer" onClick={() => setShowImportDialog(false)}>
              Cancel
            </Button>
            <Button
              size="sm" className="text-xs h-7 cursor-pointer"
              disabled={!importData.trim() || !importPassword || importing}
              onClick={doImport}
            >
              {importing ? <><Loader2 className="size-3 animate-spin mr-1" /> Importing...</> : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
