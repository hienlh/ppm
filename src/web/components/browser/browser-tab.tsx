import { useState, useRef, useCallback } from "react";
import { ExternalLink, Globe, Loader2, RefreshCw, X } from "lucide-react";
import { useTabStore } from "@/stores/tab-store";
import { api } from "@/lib/api-client";

interface BrowserTabProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

export function BrowserTab({ metadata, tabId }: BrowserTabProps) {
  const initialPort = (metadata?.port as number) || 0;
  const [portInput, setPortInput] = useState(initialPort ? String(initialPort) : "");
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const updateTab = useTabStore((s) => s.updateTab);

  const startTunnel = useCallback(async (port: number) => {
    setLoading(true);
    setError(null);
    setTunnelUrl(null);

    try {
      const res = await api.post<{ port: number; url: string }>("/api/preview/tunnel", { port });
      setTunnelUrl(res.url);
      if (tabId) updateTab(tabId, { title: `localhost:${port}`, metadata: { ...metadata, port } });
    } catch (e: any) {
      setError(e.message || `Failed to start tunnel for port ${port}`);
    } finally {
      setLoading(false);
    }
  }, [tabId, metadata, updateTab]);

  const stopTunnel = useCallback(async () => {
    const port = parseInt(portInput, 10);
    if (!port) return;
    try { await api.del(`/api/preview/tunnel/${port}`); } catch {}
    setTunnelUrl(null);
    if (tabId) updateTab(tabId, { title: "Browser" });
  }, [portInput, tabId, updateTab]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const port = parseInt(portInput, 10);
    if (port >= 1 && port <= 65535) startTunnel(port);
    else setError("Port must be 1-65535");
  };

  const reload = () => {
    if (iframeRef.current) {
      const src = iframeRef.current.src;
      iframeRef.current.src = "";
      requestAnimationFrame(() => { if (iframeRef.current) iframeRef.current.src = src; });
    }
  };

  // No tunnel yet — show port input
  if (!tunnelUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
        <Globe className="size-12 text-text-subtle" />
        <h2 className="text-lg font-medium text-text-primary">Open Localhost</h2>
        <p className="text-sm text-text-secondary text-center max-w-sm">
          Enter the port of your local dev server to preview it here.
        </p>
        <form onSubmit={handleSubmit} className="flex items-center gap-2 w-full max-w-xs">
          <div className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-surface border border-border focus-within:border-accent/50 transition-colors">
            <span className="text-sm text-text-subtle shrink-0">localhost:</span>
            <input
              type="number"
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              placeholder="3000"
              min={1}
              max={65535}
              autoFocus
              className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-subtle min-w-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !portInput}
            className="px-4 py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors shrink-0"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : "Open"}
          </button>
        </form>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {loading && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="size-4 animate-spin" />
            <span>Starting tunnel... (may take a few seconds)</span>
          </div>
        )}
      </div>
    );
  }

  // Tunnel active — show iframe
  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-surface shrink-0">
        <Globe className="size-4 text-text-subtle shrink-0" />
        <span className="text-xs text-text-primary font-medium">localhost:{portInput}</span>
        <span className="text-xs text-text-subtle truncate ml-1">({tunnelUrl})</span>
        <div className="flex-1" />
        <button
          onClick={reload}
          className="p-1.5 rounded hover:bg-surface-elevated transition-colors"
          title="Reload"
        >
          <RefreshCw className="size-3.5" />
        </button>
        <button
          onClick={() => window.open(tunnelUrl, "_blank")}
          className="p-1.5 rounded hover:bg-surface-elevated transition-colors"
          title="Open in browser"
        >
          <ExternalLink className="size-3.5" />
        </button>
        <button
          onClick={stopTunnel}
          className="p-1.5 rounded hover:bg-surface-elevated text-red-400 transition-colors"
          title="Stop tunnel"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* iframe */}
      <div className="flex-1 relative min-h-0">
        <iframe
          ref={iframeRef}
          src={tunnelUrl}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          onLoad={() => setLoading(false)}
        />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50">
            <Loader2 className="size-5 animate-spin text-text-secondary" />
          </div>
        )}
      </div>
    </div>
  );
}
