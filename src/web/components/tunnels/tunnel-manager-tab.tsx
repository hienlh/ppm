import { useState, useEffect, useCallback } from "react";
import { Check, Copy, ExternalLink, Globe, Loader2, Lock, RefreshCw, Square } from "lucide-react";
import { tunnelsApi, type TunnelEntry } from "@/lib/api-tunnels";
import { toast } from "sonner";

/** Badge label + style per tunnel source. */
const SOURCE_META: Record<TunnelEntry["source"], { label: string; cls: string }> = {
  app: { label: "app", cls: "bg-primary/10 text-primary" },
  ppm: { label: "ppm", cls: "bg-success/10 text-success" },
  external: { label: "external", cls: "bg-surface-elevated text-text-secondary" },
};

export function TunnelManagerTab() {
  const [tunnels, setTunnels] = useState<TunnelEntry[]>([]);
  const [portInput, setPortInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedPid, setCopiedPid] = useState<number | null>(null);
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // force=true bypasses the server's 2s cache (manual refresh); background
  // polls stay non-force and keep the existing list visible (no flicker).
  const fetchTunnels = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      setTunnels(await tunnelsApi.list(force));
    } catch (e) {
      console.warn("[tunnels] failed to fetch", e);
    } finally {
      setHasFetched(true);
      if (force) setRefreshing(false);
    }
  }, []);

  // Fetch on mount + poll every 10s (server-side cache keeps this cheap).
  useEffect(() => {
    fetchTunnels();
    const interval = setInterval(() => fetchTunnels(), 10_000);
    return () => clearInterval(interval);
  }, [fetchTunnels]);

  const startTunnel = async (port: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await tunnelsApi.start(port);
      window.open(res.url, "_blank");
      setPortInput("");
      await fetchTunnels();
    } catch (e: any) {
      setError(e.message || `Failed to start tunnel for port ${port}`);
    } finally {
      setLoading(false);
    }
  };

  const stopTunnel = async (t: TunnelEntry) => {
    // External tunnels (possibly another app's / production) require a 2nd click.
    if (t.source === "external" && confirmPid !== t.pid) {
      setConfirmPid(t.pid);
      setTimeout(() => setConfirmPid((p) => (p === t.pid ? null : p)), 4000);
      return;
    }
    setConfirmPid(null);
    try {
      await tunnelsApi.stop(t.pid);
      await fetchTunnels();
    } catch (e: any) {
      toast.error(e.message || `Failed to stop tunnel (pid ${t.pid})`);
    }
  };

  const copyUrl = (pid: number, url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedPid(pid);
      toast.success("URL copied");
      setTimeout(() => setCopiedPid(null), 2000);
    }).catch(() => toast.error("Failed to copy URL"));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const port = parseInt(portInput, 10);
    if (port >= 1 && port <= 65535) startTunnel(port);
    else setError("Port must be 1-65535");
  };

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Compact start form (sidebar section is already labelled in the rail) */}
      <div className="p-3 border-b border-border bg-surface">
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <div className="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-background border border-border focus-within:border-primary/50 transition-colors">
            <span className="text-xs text-text-subtle shrink-0">localhost:</span>
            <input
              type="number"
              value={portInput}
              onChange={(e) => { setPortInput(e.target.value); setError(null); }}
              placeholder="3000"
              min={1}
              max={65535}
              className="flex-1 min-w-0 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-subtle [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !portInput}
            className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors shrink-0 flex items-center justify-center"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : "Forward"}
          </button>
          <button
            type="button"
            onClick={() => fetchTunnels(true)}
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh tunnels"
            className="shrink-0 p-2 rounded-lg hover:bg-surface-elevated transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`size-4 text-text-secondary ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </form>
        {error && <p className="text-xs text-error mt-2">{error}</p>}
      </div>

      {/* Tunnel list */}
      <div className="flex-1 overflow-y-auto p-3">
        {!hasFetched ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : tunnels.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-2">
            <Globe className="size-8 text-text-subtle" />
            <p className="text-xs text-text-secondary">
              No cloudflared tunnels running. Forward a port, or start one elsewhere and it will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {tunnels.map((t) => (
              <div key={t.pid} className="p-2.5 rounded-lg bg-surface border border-border">
                {/* Line 1: port + source chip · stop/lock */}
                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-mono text-sm font-medium text-text-primary">
                    {t.port != null ? `:${t.port}` : "—"}
                  </span>
                  <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${SOURCE_META[t.source].cls}`}>
                    {SOURCE_META[t.source].label}
                  </span>
                  <div className="flex-1" />
                  {t.protected ? (
                    <div className="shrink-0 p-1.5" title="App tunnel — managed by PPM, not stoppable here">
                      <Lock className="size-4 text-text-subtle" />
                    </div>
                  ) : (
                    <button
                      onClick={() => stopTunnel(t)}
                      className={`shrink-0 h-8 min-w-8 px-1.5 flex items-center justify-center rounded-md transition-colors ${confirmPid === t.pid ? "bg-error/15" : "hover:bg-error/10"}`}
                      title={confirmPid === t.pid ? "Click again to confirm stop" : "Stop tunnel"}
                    >
                      {confirmPid === t.pid
                        ? <span className="text-[10px] font-medium text-error">Sure?</span>
                        : <Square className="size-4 text-error" />}
                    </button>
                  )}
                </div>

                {/* Line 2: URL (full-width truncate) + open/copy */}
                <div className="flex items-center gap-1 mt-1">
                  <span className={`flex-1 min-w-0 truncate text-xs ${t.url ? "text-text-secondary" : "text-text-subtle italic"}`}>
                    {t.url ?? "unknown"}
                  </span>
                  {t.url && (
                    <>
                      <button onClick={() => window.open(t.url!, "_blank")} className="shrink-0 p-1.5 rounded-md hover:bg-surface-elevated transition-colors" title="Open in browser">
                        <ExternalLink className="size-3.5 text-text-secondary" />
                      </button>
                      <button onClick={() => copyUrl(t.pid, t.url!)} className="shrink-0 p-1.5 rounded-md hover:bg-surface-elevated transition-colors" title="Copy URL">
                        {copiedPid === t.pid ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5 text-text-secondary" />}
                      </button>
                    </>
                  )}
                </div>

                {/* Line 3: pid */}
                <div className="mt-1 text-[10px] font-mono text-text-subtle">pid {t.pid}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
