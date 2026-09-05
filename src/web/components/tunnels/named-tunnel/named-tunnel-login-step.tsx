/**
 * `login-wait` step: shows the Cloudflare login URL (openable from any
 * device, since the WS event reaches every connected client) and the 60s
 * "still waiting" banner. No countdown-to-zero — the login process survives
 * past 60s, so a countdown would wrongly imply an imminent kill.
 */
import { useState } from "react";
import { Copy, Check, ExternalLink, Loader2, AlertTriangle } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { namedTunnelCopy } from "./named-tunnel-copy";

interface Props {
  url: string | null;
  slow: boolean;
  onCancel: () => void;
}

export function NamedTunnelLoginStep({ url, slow, onCancel }: Props) {
  const [copied, setCopied] = useState(false);
  const [bannerAcked, setBannerAcked] = useState(false);
  const c = namedTunnelCopy.login;

  const showBanner = slow && !bannerAcked;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
        <p className="mt-1 text-sm text-text-secondary leading-relaxed">{c.hint}</p>
      </div>

      {url ? (
        <div className="flex items-stretch gap-2">
          <div className="min-w-0 flex-1 flex items-center px-3 py-3 rounded-lg border border-border bg-surface font-mono text-xs text-foreground truncate">
            {url}
          </div>
          <button
            type="button"
            onClick={async () => {
              const ok = await copyToClipboard(url);
              if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
            }}
            aria-label={c.copy}
            className="shrink-0 size-11 flex items-center justify-center rounded-lg border border-border hover:bg-surface-elevated transition-colors"
          >
            {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => window.open(url, "_blank", "noopener")}
            aria-label={c.open}
            className="shrink-0 size-11 flex items-center justify-center rounded-lg border border-border hover:bg-surface-elevated transition-colors"
          >
            <ExternalLink className="size-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="size-4 animate-spin" />
          {c.waiting}
        </div>
      )}

      <p className="text-xs text-text-subtle">{c.finishOnPhone}</p>

      {showBanner && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-foreground">{c.slowTitle}</p>
              <p className="text-xs text-text-secondary leading-relaxed mt-0.5">{c.slowBody}</p>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => setBannerAcked(true)}
              className="flex-1 min-h-11 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              {c.keepWaiting}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 min-h-11 py-2.5 rounded-md border border-border text-sm text-text-secondary hover:bg-surface-elevated transition-colors"
            >
              {c.cancel}
            </button>
          </div>
        </div>
      )}

      {!showBanner && (
        <button
          type="button"
          onClick={onCancel}
          className="w-full min-h-11 py-3 rounded-lg border border-border text-sm text-text-secondary hover:bg-surface-elevated transition-colors"
        >
          {c.cancel}
        </button>
      )}
    </div>
  );
}
