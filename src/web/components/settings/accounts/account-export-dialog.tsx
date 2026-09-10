import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Download, Copy, Lock } from "lucide-react";
import { getAuthToken } from "../../../lib/api-client";
import { copyToClipboard } from "@/lib/clipboard";
import type { AccountInfo } from "../../../lib/api-settings";
import { DEFAULT_PASSWORD, downloadBackup } from "./account-backup-format";

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
        if (await copyToClipboard(text)) {
          onMessage?.("Backup copied to clipboard!");
        } else {
          downloadBackup(text);
          onMessage?.("Backup downloaded.");
        }
      } else {
        downloadBackup(text);
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
            <div className="rounded-md border border-error/30 bg-error/5 p-2.5">
              <p className="text-[10px] font-medium text-error">Full transfer — source accounts will expire</p>
              <p className="text-[10px] text-muted-foreground">Refresh tokens included. Source machine expires in ~1h after target refreshes.</p>
            </div>
          ) : refreshBefore ? (
            <div className="rounded-md border border-warning/30 bg-warning/5 p-2.5">
              <p className="text-[10px] font-medium text-warning">Refresh before export — invalidates previous shares</p>
            </div>
          ) : (
            <div className="rounded-md border border-success/30 bg-success/5 p-2.5">
              <p className="text-[10px] font-medium text-success">Share current token (safe)</p>
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
