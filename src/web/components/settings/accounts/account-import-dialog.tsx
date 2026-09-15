import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Lock } from "@/lib/icons";
import { importAccounts } from "../../../lib/api-settings";
import { DEFAULT_PASSWORD } from "./account-backup-format";

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
        {error && <div className="text-[11px] p-2 rounded bg-error/10 text-error">{error}</div>}
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
