import { useState, useEffect, useCallback } from "react";
import { Check, Copy, ExternalLink, Globe, Loader2, Lock, Square, Wifi } from "lucide-react";
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

  const fetchTunnels = useCallback(async () => {
    try {
      setTunnels(await tunnelsApi.list());
    } catch (e) {
      console.warn("[tunnels] failed to fetch", e);
    }
  }, []);

  // Fetch on mount + poll every 10s (server-side cache keeps this cheap).
  useEffect(() => {
    fetchTunnels();
    const interval = setInterval(fetchTunnels, 10_000);
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
      {/* Header + start form */}
      <div className="p-4 md:p-6 border-b border-border bg-surface">
        <div className="flex items-center gap-2 mb-3">
          <Wifi className="size-5 text-primary" />
          <h2 className="text-base font-medium text-text-primary">Cloudflare Tunnels</h2>
        </div>
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-background border border-border focus-within:border-primary/50 transition-colors">
            <span className="text-sm text-text-subtle shrink-0">localhost:</span>
            <input
              type="number"
              value={portInput}
              onChange={(e) => { setPortInput(e.target.value); setError(null); }}
              placeholder="3000"
              min={1}
              max={65535}
              className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-subtle min-w-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !portInput}
            className="px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors shrink-0 min-w-[72px] flex items-center justify-center"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : "Forward"}
          </button>
        </form>
        {error && <p className="text-sm text-error mt-2">{error}</p>}
      </div>

      {/* Tunnel list */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {tunnels.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <Globe className="size-10 text-text-subtle" />
            <p className="text-sm text-text-secondary max-w-xs">
              No cloudflared tunnels running. Forward a port, or start one elsewhere and it will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {tunnels.map((t) => (
              <div key={t.pid} className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-border">
                {/* Source badge */}
                <span className={`shrink-0 px-2 py-1 rounded text-[10px] font-medium uppercase tracking-wide ${SOURCE_META[t.source].cls}`}>
                  {SOURCE_META[t.source].label}
                </span>

                {/* PID + port + url */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs font-mono text-text-secondary">
                    <span>pid {t.pid}</span>
                    {t.port != null && <span className="text-text-subtle">·</span>}
                    {t.port != null && <span>:{t.port}</span>}
                  </div>
                  <div className="text-xs truncate min-w-0 mt-0.5">
                    {t.url
                      ? <span className="text-text-secondary">{t.url}</span>
                      : <span className="text-text-subtle italic">unknown</span>}
                  </div>
                </div>

                {/* Actions — 44px touch targets */}
                <div className="flex items-center shrink-0">
                  {t.url && (
                    <>
                      <button onClick={() => window.open(t.url!, "_blank")} className="p-2.5 rounded-md hover:bg-surface-elevated transition-colors" title="Open in browser">
                        <ExternalLink className="size-4 text-text-secondary" />
                      </button>
                      <button onClick={() => copyUrl(t.pid, t.url!)} className="p-2.5 rounded-md hover:bg-surface-elevated transition-colors" title="Copy URL">
                        {copiedPid === t.pid ? <Check className="size-4 text-success" /> : <Copy className="size-4 text-text-secondary" />}
                      </button>
                    </>
                  )}
                  {t.protected ? (
                    <div className="p-2.5" title="App tunnel — managed by PPM, not stoppable here">
                      <Lock className="size-4 text-text-subtle" />
                    </div>
                  ) : (
                    <button
                      onClick={() => stopTunnel(t)}
                      className={`p-2.5 rounded-md transition-colors ${confirmPid === t.pid ? "bg-error/15" : "hover:bg-error/10"}`}
                      title={confirmPid === t.pid ? "Click again to confirm stop" : "Stop tunnel"}
                    >
                      {confirmPid === t.pid
                        ? <span className="text-[10px] font-medium text-error px-0.5">Sure?</span>
                        : <Square className="size-4 text-error" />}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
