/**
 * Add a Codex account: sign in with ChatGPT, or paste an API key.
 *
 * Presentational only — every piece of state and each handler stays in the pane. The
 * device-code login owns a server-side app-server that has to be released if the user walks
 * away, and the pane's unmount effect is what does that; moving the flow's state in here
 * would tie that release to closing a dialog instead.
 *
 * Mirrors the Claude add dialog: recommended sign-in first, divider, manual key below.
 */

import { ExternalLink, KeyRound, Loader2, MonitorSmartphone } from "lucide-react";
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
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Add Codex Account</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Each account keeps its own login (its own <code>CODEX_HOME</code>).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-[11px] font-medium">Recommended: sign in with ChatGPT</p>
            <Button
              size="sm"
              className="w-full cursor-pointer gap-1.5"
              onClick={onStartDevice}
              disabled={deviceWaiting}
            >
              {deviceWaiting
                ? <><Loader2 className="size-4 animate-spin" /> Waiting for authorization...</>
                : <><MonitorSmartphone className="size-4" /> Sign in with ChatGPT</>}
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
          <div className="space-y-1.5">
            <Label htmlFor="codex-label" className="text-xs">Label (optional)</Label>
            <Input
              id="codex-label"
              placeholder="e.g. Personal, Work"
              value={label}
              onChange={(e) => onLabelChange(e.target.value)}
              className="text-xs"
            />
          </div>
        </div>

        {error && <div className="text-[11px] p-2 rounded bg-error/10 text-error">{error}</div>}

        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs cursor-pointer" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="text-xs cursor-pointer gap-1.5"
            onClick={onAddApiKey}
            disabled={!apiKey.trim() || adding}
          >
            {adding ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
            Add key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
