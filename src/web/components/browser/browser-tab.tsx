import { useState, useEffect, useCallback } from "react";
import { Check, Copy, ExternalLink, Globe, Loader2, Square, Wifi } from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface TunnelInfo {
  port: number;
  url: string;
  startedAt: number;
}

export function BrowserTab() {
  const [portInput, setPortInput] = useState("");
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedPort, setCopiedPort] = useState<number | null>(null);

  const fetchTunnels = useCallback(async () => {
    try {
      const list = await api.get<TunnelInfo[]>("/api/preview/tunnels");
      setTunnels(list);
    } catch (e) {
      console.warn("[ports] failed to fetch tunnels", e);
    }
  }, []);

  // Fetch tunnels on mount + poll every 10s
  useEffect(() => {
    fetchTunnels();
    const interval = setInterval(fetchTunnels, 10_000);
    return () => clearInterval(interval);
  }, [fetchTunnels]);

  const startTunnel = async (port: number) => {
    // Check if already forwarded
    const existing = tunnels.find((t) => t.port === port);
    if (existing) {
      window.open(existing.url, "_blank");
      setPortInput("");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await api.post<{ port: number; url: string }>("/api/preview/tunnel", { port });
      window.open(res.url, "_blank");
      setPortInput("");
      await fetchTunnels();
    } catch (e: any) {
      setError(e.message || `Failed to start tunnel for port ${port}`);
    } finally {
      setLoading(false);
    }
  };

  const stopTunnel = async (port: number) => {
    try {
      await api.del(`/api/preview/tunnel/${port}`);
      await fetchTunnels();
    } catch (e: any) {
      toast.error(e.message || `Failed to stop tunnel for port ${port}`);
    }
  };

  const copyUrl = (port: number, url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedPort(port);
      toast.success("URL copied");
      setTimeout(() => setCopiedPort(null), 2000);
    }).catch(() => {
      toast.error("Failed to copy URL");
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const port = parseInt(portInput, 10);
    if (port >= 1 && port <= 65535) startTunnel(port);
    else setError("Port must be 1-65535");
  };

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Header + form */}
      <div className="p-4 md:p-6 border-b border-border bg-surface">
        <div className="flex items-center gap-2 mb-3">
          <Wifi className="size-5 text-primary" />
          <h2 className="text-base font-medium text-text-primary">Port Forwarding</h2>
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
        {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
        {loading && (
          <div className="flex items-center gap-2 text-sm text-text-secondary mt-2">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Starting tunnel...</span>
          </div>
        )}
      </div>

      {/* Tunnel list */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {tunnels.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <Globe className="size-10 text-text-subtle" />
            <p className="text-sm text-text-secondary max-w-xs">
              No active ports. Forward a port to access your local dev server from anywhere.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {tunnels.map((t) => (
              <div
                key={t.port}
                className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-border"
              >
                {/* Port badge */}
                <div className="shrink-0 px-2 py-1 rounded bg-primary/10 text-primary text-xs font-mono font-medium">
                  :{t.port}
                </div>

                {/* URL - truncated */}
                <span className="flex-1 text-xs text-text-secondary truncate min-w-0">
                  {t.url}
                </span>

                {/* Actions — 44px touch targets */}
                <div className="flex items-center shrink-0">
                  <button
                    onClick={() => window.open(t.url, "_blank")}
                    className="p-2.5 rounded-md hover:bg-surface-elevated transition-colors"
                    title="Open in browser"
                  >
                    <ExternalLink className="size-4 text-text-secondary" />
                  </button>
                  <button
                    onClick={() => copyUrl(t.port, t.url)}
                    className="p-2.5 rounded-md hover:bg-surface-elevated transition-colors"
                    title="Copy URL"
                  >
                    {copiedPort === t.port
                      ? <Check className="size-4 text-green-400" />
                      : <Copy className="size-4 text-text-secondary" />}
                  </button>
                  <button
                    onClick={() => stopTunnel(t.port)}
                    className="p-2.5 rounded-md hover:bg-red-500/10 transition-colors"
                    title="Stop tunnel"
                  >
                    <Square className="size-4 text-red-400" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
