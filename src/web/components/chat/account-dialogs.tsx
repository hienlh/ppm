import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Download, Copy, Lock } from "lucide-react";
import { getAuthToken } from "../../lib/api-client";
import {
  addAccount,
  getOAuthUrl,
  exchangeOAuthCode,
  importAccounts,
  type AccountInfo,
} from "../../lib/api-settings";

const DEFAULT_PASSWORD = "ppm-hienlh";

// ── Add Account Dialog ─────────────────────────────────────────────

interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (msg?: string) => void;
}

export function AddAccountDialog({ open, onOpenChange, onSuccess }: AddAccountDialogProps) {
  const [newToken, setNewToken] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthStep, setOauthStep] = useState<"idle" | "waiting">("idle");

  function resetOAuth() {
    setOauthState(null);
    setOauthCode("");
    setOauthStep("idle");
    setAddError(null);
  }

  function handleClose() {
    onOpenChange(false);
    resetOAuth();
    setNewToken("");
    setNewLabel("");
    setAddError(null);
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
      let code = oauthCode.trim();
      if (code.includes("#")) code = code.split("#")[0] ?? code;
      await exchangeOAuthCode(code, oauthState);
      handleClose();
      onSuccess("Account connected via OAuth!");
    } catch (e) {
      setAddError((e as Error).message);
    }
    setOauthLoading(false);
  }

  async function handleAddToken() {
    if (!newToken.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await addAccount({ apiKey: newToken.trim(), label: newLabel.trim() || undefined });
      handleClose();
      onSuccess("Account added!");
    } catch (e) {
      setAddError((e as Error).message);
    }
    setAdding(false);
  }

  const tokenHint = newToken.trim()
    ? newToken.trim().startsWith("sk-ant-oat") ? "OAuth token (Claude Max/Pro)"
    : newToken.trim().startsWith("sk-ant-api") ? "API key"
    : "Unknown format"
    : "";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Add Claude Account</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Connect via OAuth (recommended) or paste a token manually.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* OAuth login */}
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-[11px] font-medium">Recommended: Login with Claude</p>
            {oauthStep === "idle" ? (
              <Button size="sm" className="w-full h-8 text-xs" onClick={handleOAuthLogin} disabled={oauthLoading}>
                {oauthLoading ? <><Loader2 className="size-3 animate-spin mr-1" /> Opening...</> : "Login with Claude"}
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-[10px] text-muted-foreground">Authorize in the opened tab, then paste the code:</p>
                <Input placeholder="Paste code here..." value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} className="text-xs h-8 font-mono" autoFocus />
                <div className="flex gap-1.5">
                  <Button size="sm" className="flex-1 h-7 text-xs" onClick={handleOAuthExchange} disabled={!oauthCode.trim() || oauthLoading}>
                    {oauthLoading ? <><Loader2 className="size-3 animate-spin mr-1" /> Connecting...</> : "Connect"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={resetOAuth}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 border-t" />
            <span className="text-[10px] text-muted-foreground">or paste token</span>
            <div className="flex-1 border-t" />
          </div>
          {/* Manual token */}
          <div className="space-y-1.5">
            <Label htmlFor="add-token" className="text-xs">Token</Label>
            <Input id="add-token" type="password" placeholder="sk-ant-..." value={newToken} onChange={(e) => setNewToken(e.target.value)} className="text-xs h-8 font-mono" />
            {tokenHint && <p className="text-[10px] text-muted-foreground">Detected: {tokenHint}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-label" className="text-xs">Label (optional)</Label>
            <Input id="add-label" placeholder="e.g. Personal, Work" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} className="text-xs h-8" />
          </div>
        </div>
        {addError && <div className="text-[11px] p-2 rounded bg-red-500/10 text-red-600">{addError}</div>}
        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={handleClose}>Cancel</Button>
          <Button size="sm" className="text-xs h-7" onClick={handleAddToken} disabled={!newToken.trim() || adding}>
            {adding ? "Adding..." : "Add Token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Export Accounts Dialog ──────────────────────────────────────────

interface ExportAccountsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountInfo[];
  preselectId?: string | null;
  onMessage?: (msg: string) => void;
}

export function ExportAccountsDialog({ open, onOpenChange, accounts, preselectId, onMessage }: ExportAccountsDialogProps) {
  const exportable = accounts.filter((a) => a.hasRefreshToken);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState("");
  const [fullTransfer, setFullTransfer] = useState(false);
  const [refreshBefore, setRefreshBefore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Initialize selection when dialog opens
  if (open && !initialized) {
    setSelected(preselectId ? new Set([preselectId]) : new Set(exportable.map((a) => a.id)));
    setInitialized(true);
  }
  if (!open && initialized) {
    setInitialized(false);
  }

  function handleClose() {
    onOpenChange(false);
    setPassword("");
    setFullTransfer(false);
    setRefreshBefore(false);
  }

  async function doExport(toClipboard: boolean) {
    if (selected.size === 0) return;
    setExporting(true);
    const effectivePassword = password.trim() || DEFAULT_PASSWORD;
    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/accounts/export", {
        method: "POST",
        headers,
        body: JSON.stringify({ password: effectivePassword, accountIds: [...selected], includeRefreshToken: fullTransfer, refreshBeforeExport: refreshBefore }),
      });
      if (!res.ok) { const j = await res.json() as any; throw new Error(j.error ?? `Export failed: ${res.status}`); }
      const text = await res.text();
      if (toClipboard) {
        try {
          await navigator.clipboard.writeText(text);
          onMessage?.("Backup copied to clipboard!");
        } catch {
          downloadBlob(text);
          onMessage?.("Backup downloaded.");
        }
      } else {
        downloadBlob(text);
        onMessage?.("Backup downloaded.");
      }
      handleClose();
    } catch { /* silent */ }
    setExporting(false);
  }

  const valid = selected.size > 0 && !exporting;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
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
              <button className="text-[10px] text-primary hover:underline cursor-pointer" onClick={() => setSelected(selected.size === exportable.length ? new Set() : new Set(exportable.map((a) => a.id)))}>
                {selected.size === exportable.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            {exportable.length === 0 ? (
              <p className="text-[10px] text-muted-foreground p-2 border rounded">No exportable accounts.</p>
            ) : (
              <div className="max-h-36 overflow-y-auto space-y-1 border rounded p-2">
                {exportable.map((acc) => (
                  <div key={acc.id} className="flex items-center gap-2">
                    <input type="checkbox" id={`exp-${acc.id}`} checked={selected.has(acc.id)} onChange={(e) => { const s = new Set(selected); e.target.checked ? s.add(acc.id) : s.delete(acc.id); setSelected(s); }} className="size-3.5 accent-primary cursor-pointer" />
                    <label htmlFor={`exp-${acc.id}`} className="text-xs cursor-pointer truncate">
                      {acc.label ?? acc.email ?? acc.id.slice(0, 8)}
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Password (optional) */}
          <div className="space-y-1.5">
            <Label className="text-xs">Password <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input type="password" placeholder="Leave empty for default" value={password} onChange={(e) => setPassword(e.target.value)} className="text-xs h-8" autoComplete="new-password" />
          </div>
          {/* Options */}
          <div className="flex items-center gap-2">
            <input type="checkbox" id="exp-full" checked={fullTransfer} onChange={(e) => setFullTransfer(e.target.checked)} className="size-3.5 accent-primary cursor-pointer" />
            <label htmlFor="exp-full" className="text-[11px] cursor-pointer">Include refresh tokens (full transfer)</label>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="exp-refresh" checked={refreshBefore} onChange={(e) => setRefreshBefore(e.target.checked)} className="size-3.5 accent-primary cursor-pointer" />
            <label htmlFor="exp-refresh" className="text-[11px] cursor-pointer">Refresh tokens before export</label>
          </div>
          {/* Warning */}
          {fullTransfer ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-2.5">
              <p className="text-[10px] font-medium text-red-600">Full transfer — source accounts will expire</p>
              <p className="text-[10px] text-muted-foreground">Refresh tokens included. Source machine expires in ~1h after target refreshes.</p>
            </div>
          ) : refreshBefore ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
              <p className="text-[10px] font-medium text-amber-600">Refresh before export — invalidates previous shares</p>
            </div>
          ) : (
            <div className="rounded-md border border-green-500/30 bg-green-500/5 p-2.5">
              <p className="text-[10px] font-medium text-green-600">Share current token (safe)</p>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">Encrypted with AES-256-GCM + scrypt.</p>
        </div>
        <DialogFooter className="gap-1.5 flex-col sm:flex-row">
          <Button size="sm" variant="outline" className="text-xs h-7 cursor-pointer" onClick={handleClose}>Cancel</Button>
          <Button size="sm" variant="outline" className="text-xs h-7 cursor-pointer" disabled={!valid} onClick={() => doExport(true)}>
            <Copy className="size-3 mr-1" /> Copy
          </Button>
          <Button size="sm" className="text-xs h-7 cursor-pointer" disabled={!valid} onClick={() => doExport(false)}>
            {exporting ? <><Loader2 className="size-3 animate-spin mr-1" /> Exporting...</> : <><Download className="size-3 mr-1" /> Download</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Import Accounts Dialog ─────────────────────────────────────────

interface ImportAccountsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (msg?: string) => void;
}

export function ImportAccountsDialog({ open, onOpenChange, onSuccess }: ImportAccountsDialogProps) {
  const [data, setData] = useState("");
  const [password, setPassword] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClose() {
    onOpenChange(false);
    setData("");
    setPassword("");
    setError(null);
  }

  async function doImport() {
    if (!data.trim()) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importAccounts({ data: data.trim(), password: password.trim() || DEFAULT_PASSWORD });
      handleClose();
      onSuccess(`Imported ${result.imported} account(s)`);
    } catch (e) {
      setError((e as Error).message || "Import failed");
    }
    setImporting(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-1.5"><Lock className="size-3.5" /> Import Accounts</DialogTitle>
          <DialogDescription className="text-xs">Paste backup data and enter the export password. Imported accounts are temporary (~1h).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Backup data</Label>
            <textarea value={data} onChange={(e) => setData(e.target.value)} placeholder="Paste backup JSON here..." rows={4} className="w-full text-xs p-2 rounded border border-border bg-background font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Password <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input type="password" placeholder="Leave empty for default" value={password} onChange={(e) => setPassword(e.target.value)} className="text-xs h-8" autoComplete="current-password" />
          </div>
        </div>
        {error && <div className="text-[11px] p-2 rounded bg-red-500/10 text-red-600">{error}</div>}
        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs h-7 cursor-pointer" onClick={handleClose}>Cancel</Button>
          <Button size="sm" className="text-xs h-7 cursor-pointer" disabled={!data.trim() || importing} onClick={doImport}>
            {importing ? <><Loader2 className="size-3 animate-spin mr-1" /> Importing...</> : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function downloadBlob(text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ppm-accounts-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
}
