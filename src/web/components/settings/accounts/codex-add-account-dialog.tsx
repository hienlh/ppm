/** Add a Codex account through browser login, device code, or an API key. */

import { ExternalLink, KeyRound, Loader2, MonitorSmartphone } from "@/lib/icons";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface CodexDevicePrompt {
  userCode: string;
  verificationUrl: string;
}

export function CodexAddAccountDialog({
  open, onOpenChange, label, onLabelChange, apiKey, onApiKeyChange,
  adding, onAddApiKey, deviceWaiting, onStartDevice, device, error,
  browser, onStartBrowser, loginStarting, callbackUrl, onCallbackUrlChange, submittingCallback, onSubmitCallback,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  onLabelChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  adding: boolean;
  onAddApiKey: () => void;
  deviceWaiting: boolean;
  onStartDevice: () => void;
  device: CodexDevicePrompt | null;
  error: string | null;
  browser: { authUrl: string } | null;
  onStartBrowser: () => void;
  loginStarting: boolean;
  callbackUrl: string;
  onCallbackUrlChange: (value: string) => void;
  submittingCallback: boolean;
  onSubmitCallback: () => void;
}) {
  const loginBusy = loginStarting || deviceWaiting || !!browser || adding;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Add Codex Account</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Choose browser login, a device code, or an OpenAI API key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="codex-label" className="text-xs">Label (optional)</Label>
            <Input id="codex-label" placeholder="e.g. Personal, Work" value={label}
              onChange={(e) => onLabelChange(e.target.value)} disabled={loginBusy} className="text-xs" />
          </div>
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-[11px] font-medium">Browser login</p>
            <Button size="sm" className="w-full cursor-pointer gap-1.5" onClick={onStartBrowser} disabled={loginBusy}>
              <ExternalLink className="size-4" /> Sign in with browser
            </Button>
            {browser && (
              <div className="space-y-2 text-xs">
                <a href={browser.authUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  <ExternalLink className="size-3" /> Open ChatGPT sign-in
                </a>
                <p>Sign in, then copy the full localhost callback URL from the address bar and paste it below. On a phone, copy it even if the page fails to load.</p>
                <Label htmlFor="codex-callback-url">Callback URL</Label>
                <Input id="codex-callback-url" type="password" autoComplete="off" spellCheck={false}
                  placeholder="http://localhost:.../auth/callback?..." value={callbackUrl}
                  onChange={(e) => onCallbackUrlChange(e.target.value)} disabled={submittingCallback} />
                <Button size="sm" onClick={onSubmitCallback} disabled={!callbackUrl.trim() || submittingCallback}>
                  {submittingCallback && <Loader2 className="size-3 animate-spin" />} Submit callback URL
                </Button>
                <p role="status" className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Waiting for authorization. This may complete automatically on this computer.
                </p>
              </div>
            )}
          </div>
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-[11px] font-medium">Device code</p>
            <Button
              size="sm"
              className="w-full cursor-pointer gap-1.5"
              onClick={onStartDevice}
              disabled={loginBusy}
            >
              {deviceWaiting
                ? <><Loader2 className="size-4 animate-spin" /> Waiting for authorization...</>
                : <><MonitorSmartphone className="size-4" /> Sign in with device code</>}
            </Button>

            {device && (
              <div className="rounded-md border border-primary/40 bg-primary/10 p-2.5 space-y-1.5">
                <p className="text-[11px]">Enter this code to authorize:</p>
                <div className="font-mono text-lg tracking-widest">{device.userCode}</div>
                <a
                  href={device.verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline text-[11px]"
                >
                  <ExternalLink className="size-3" /> {device.verificationUrl}
                </a>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 border-t" />
            <span className="text-[10px] text-muted-foreground">or paste an API key</span>
            <div className="flex-1 border-t" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="codex-api-key" className="text-xs">OpenAI API key</Label>
            <Input
              id="codex-api-key"
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              className="text-xs font-mono"
            />
          </div>
        </div>

        {loginStarting && <p role="status" className="text-xs">Starting login...</p>}
        {error && <div role="alert" className="text-[11px] p-2 rounded bg-error/10 text-error">{error}</div>}

        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs cursor-pointer" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="text-xs cursor-pointer gap-1.5"
            onClick={onAddApiKey}
            disabled={!apiKey.trim() || loginBusy}
          >
            {adding ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
            Add key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
