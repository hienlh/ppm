import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Globe, Lock, RotateCw } from "@/lib/icons";
import { tunnelsApi } from "@/lib/api-tunnels";
import { copyToClipboard } from "@/lib/clipboard";
import { safePreviewUrl } from "@/lib/web-preview-url";

const actionClass =
  "flex items-center justify-center shrink-0 rounded min-h-11 min-w-11 md:min-h-7 md:min-w-7 text-muted-foreground hover:text-foreground hover:bg-muted";

/** How long the frame waits for PPM's answer before loading anyway. */
const FRAMING_WAIT_MS = 3000;

/**
 * Tell the forward this PPM may frame it, so a page sending `X-Frame-Options` still shows. The
 * server keeps the answer in memory, so it is asked again before every load: a restart forgets
 * it. Settles either way, because a server too old for the route, or one that is restarting,
 * can still show every page that allows framing.
 */
function allowFramingHere(): Promise<void> {
  return Promise.race([
    tunnelsApi.allowFraming(window.location.origin).then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, FRAMING_WAIT_MS)),
  ]);
}

/**
 * A dev server on the host, forwarded and shown in a tab. The toolbar sits at the bottom
 * below `md`, in the thumb zone, as a phone browser's address bar does.
 */
export function WebPreviewTab({ metadata }: { metadata?: Record<string, unknown> }) {
  const url = safePreviewUrl(metadata?.url, window.location.origin);
  const isPrivate = metadata?.via === "tailscale";
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [framingAsked, setFramingAsked] = useState(false);

  useEffect(() => {
    let live = true;
    void allowFramingHere().then(() => { if (live) setFramingAsked(true); });
    return () => { live = false; };
  }, []);

  if (!url) {
    return <div role="alert" className="p-4 text-sm text-destructive">This preview has no address PPM can show.</div>;
  }

  const copy = () => {
    void copyToClipboard(url).then((ok) => {
      if (!ok) { toast.error("Failed to copy URL"); return; }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex h-full w-full flex-col-reverse md:flex-col bg-background">
      <div role="toolbar" aria-label="Web preview"
        className="flex items-center gap-2 md:gap-1 shrink-0 h-12 md:h-8 px-2 border-t md:border-t-0 md:border-b border-border">
        <span className="flex items-center justify-center shrink-0 size-7 text-muted-foreground"
          title={isPrivate ? "Private: only devices in your tailnet can open this address" : "Public: anyone with this link can open it"}>
          {isPrivate ? <Lock className="size-3.5" /> : <Globe className="size-3.5" />}
        </span>
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground select-all">{url}</span>
        <button type="button" onClick={() => void allowFramingHere().then(() => setReloadKey((k) => k + 1))} title="Reload" aria-label="Reload" className={actionClass}>
          <RotateCw className="size-4" />
        </button>
        <button type="button" onClick={copy} title="Copy URL" aria-label="Copy URL" className={actionClass}>
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </button>
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open in browser" aria-label="Open in browser" className={actionClass}>
          <ExternalLink className="size-4" />
        </a>
      </div>
      {/* Cross-origin to PPM (safePreviewUrl), so allow-same-origin only lets the app keep its
          own cookies and storage; without allow-top-navigation it cannot navigate PPM away. */}
      {framingAsked ? (
        <iframe
          key={reloadKey}
          title={`Preview of ${url}`}
          src={url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          allow="clipboard-read; clipboard-write; fullscreen"
          referrerPolicy="no-referrer"
          className="flex-1 min-h-0 w-full border-0 bg-white"
        />
      ) : (
        <div className="flex-1 min-h-0 w-full bg-white" />
      )}
    </div>
  );
}
