import { WifiOff, ServerOff, RefreshCw, Home } from "@/lib/icons";
import { useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { getCachedNamedHostname } from "@/components/tunnels/named-tunnel/use-named-tunnel-setup";
import { getLastKnownLocalUrl } from "@/lib/last-known-local-url";

const CLOUD_URL = "https://cloud.ppm.sh";

/**
 * True when this page is reached through *some* cloudflared tunnel (quick or
 * named) rather than directly (localhost/LAN IP) — that distinction decides
 * whether the "tunnel closed" or the generic "server unreachable" copy shows.
 * The named hostname is cached in memory by the setup hook the last time
 * `/status` answered while online; there is nothing else to ask once the API
 * itself is the thing that is down.
 */
function isTunnelDomain(): boolean {
  const host = window.location.hostname;
  return host.endsWith(".trycloudflare.com") || host === getCachedNamedHostname();
}

/** Reached through the user's own permanent hostname, not a temporary one. */
function isNamedDomain(): boolean {
  const cached = getCachedNamedHostname();
  return !!cached && window.location.hostname === cached;
}

export function ConnectionLostOverlay() {
  const showOverlay = useConnectionStore((s) => s.showOverlay);
  const [retrying, setRetrying] = useState(false);

  if (!showOverlay) return null;

  const isTunnel = isTunnelDomain();
  const isNamed = isNamedDomain();
  const localUrl = getLastKnownLocalUrl();

  async function handleRetry() {
    setRetrying(true);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) {
        useConnectionStore.getState().markUp();
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
        window.location.reload();
        return;
      }
    } catch {
      // still down
    }
    setRetrying(false);
  }

  const Icon = isTunnel ? WifiOff : ServerOff;

  return (
    <div className="fixed inset-0 z-[200] bg-background/95 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="max-w-sm w-full text-center space-y-6">
        <div className="flex justify-center">
          <div className="rounded-full bg-destructive/10 p-4">
            <Icon className="h-10 w-10 text-destructive" />
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-foreground">
            {isNamed ? "Domain Not Responding" : isTunnel ? "Connection Lost" : "Server Unreachable"}
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {isNamed
              // A named hostname never rotates, so "the URL changed" — true for a
              // quick tunnel — would send the user hunting for a new link that
              // does not exist. The address is fine; something behind it is not.
              ? "This address stays the same, so keep it. The machine may be asleep, offline, or restarting — it will answer again on this same URL."
              : isTunnel
              ? "The tunnel appears to have closed. The server may have restarted with a new URL."
              : "Cannot connect to the PPM server. It may have stopped or is restarting."}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {/* Same machine, same network: the LAN address bypasses Cloudflare
              entirely, so it still works when only the hostname is broken. */}
          {isTunnel && localUrl && (
            <a
              href={localUrl}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Home className="h-4 w-4" />
              Open on local network
            </a>
          )}
          {isTunnel && (
            <a
              href={CLOUD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-medium transition-colors ${
                localUrl
                  ? "border border-border text-foreground hover:bg-accent"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              Open PPM Cloud
            </a>
          )}
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${retrying ? "animate-spin" : ""}`} />
            {retrying ? "Retrying…" : "Retry Connection"}
          </button>
        </div>

        {!isTunnel && (
          <p className="text-xs text-muted-foreground">
            If the server was stopped, run <code className="bg-muted px-1 py-0.5 rounded text-[11px]">ppm start</code> to restart it.
          </p>
        )}
      </div>
    </div>
  );
}
