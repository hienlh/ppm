import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/lib/icons";
import { addAccount, getOAuthUrl, exchangeOAuthCode } from "../../../lib/api-settings";

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
      const acc = await exchangeOAuthCode(code, oauthState);
      handleClose();
      // Signing in again on an account this machine parked carries the token in but
      // deliberately leaves it out of the rotation. A flat success over a toggle that is
      // still off reads as a bug, and this is the only place the user finds out otherwise.
      onSuccess(acc?.status === "disabled"
        ? "Signed in. This account is still disabled — enable it to use it."
        : "Account connected via OAuth!");
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
      const acc = await addAccount({ apiKey: newToken.trim(), label: newLabel.trim() || undefined });
      handleClose();
      onSuccess(acc?.status === "disabled"
        ? "Token updated. This account is still disabled — enable it to use it."
        : "Account added!");
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
        {addError && <div className="text-[11px] p-2 rounded bg-error/10 text-error">{addError}</div>}
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
