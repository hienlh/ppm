import { useState, useCallback, useEffect } from "react";
import { Cloud, Share2, Loader2, Copy, Check, X, LogOut, Link, Unlink, ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@/lib/api-client";

interface CloudStatus {
  logged_in: boolean;
  email: string | null;
  cloud_url: string;
  linked: boolean;
  device_name: string | null;
  device_id: string | null;
  tunnel_active: boolean;
  tunnel_url: string | null;
}

interface TunnelStatus {
  active: boolean;
  url: string | null;
  localUrl: string | null;
}

interface Props {
  onClose: () => void;
}

export function CloudSharePopover({ onClose }: Props) {
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [tunnelStarting, setTunnelStarting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Load status on mount
  useEffect(() => {
    (async () => {
      try {
        const [cloudRes, tunnelRes] = await Promise.all([
          api.get<CloudStatus>("/api/cloud/status"),
          api.get<TunnelStatus>("/api/tunnel"),
        ]);
        setCloud(cloudRes);
        setTunnel(tunnelRes);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  const handleCopy = useCallback((url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(url);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const handleStartTunnel = useCallback(async () => {
    setTunnelStarting(true);
    setError(null);
    try {
      const result = await api.post<{ url: string }>("/api/tunnel/start", {});
      setTunnel({ active: true, url: result.url, localUrl: tunnel?.localUrl ?? null });
      // Refresh cloud status (heartbeat may have started)
      const cs = await api.get<CloudStatus>("/api/cloud/status");
      setCloud(cs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start tunnel");
    } finally {
      setTunnelStarting(false);
    }
  }, [tunnel]);

  const handleCloudLogin = useCallback(async () => {
    try {
      const { url, cloud_url } = await api.get<{ url: string; cloud_url: string }>("/api/cloud/login-url");
      // Open popup for OAuth
      const popup = window.open(url, "ppm-cloud-login", "width=500,height=600,menubar=no,toolbar=no");

      // Poll for completion — user will be redirected to /dashboard on cloud
      // We check cloud status periodically until logged_in becomes true
      const poll = setInterval(async () => {
        try {
          // Check if cloud set cookies/session
          const res = await fetch(`${cloud_url}/auth/session`, { credentials: "include" });
          if (res.ok) {
            const data = await res.json();
            if (data.user?.email) {
              clearInterval(poll);
              popup?.close();
              // Save auth to PPM server
              await api.post("/api/cloud/login", {
                access_token: "web-session", // web uses cookie-based auth
                email: data.user.email,
                cloud_url,
              });
              const cs = await api.get<CloudStatus>("/api/cloud/status");
              setCloud(cs);
            }
          }
        } catch { /* keep polling */ }
      }, 2000);

      // Stop polling after 2 minutes
      setTimeout(() => clearInterval(poll), 120_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to get login URL");
    }
  }, []);

  const handleLink = useCallback(async () => {
    setLinking(true);
    setError(null);
    try {
      // If not sharing yet, start tunnel first
      if (!tunnel?.active) {
        const result = await api.post<{ url: string }>("/api/tunnel/start", {});
        setTunnel({ active: true, url: result.url, localUrl: tunnel?.localUrl ?? null });
      }
      const result = await api.post<{ device_id: string; name: string; synced: boolean }>("/api/cloud/link", {});
      const cs = await api.get<CloudStatus>("/api/cloud/status");
      setCloud(cs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to link device");
    } finally {
      setLinking(false);
    }
  }, [tunnel]);

  const handleUnlink = useCallback(async () => {
    setUnlinking(true);
    try {
      await api.post("/api/cloud/unlink", {});
      const cs = await api.get<CloudStatus>("/api/cloud/status");
      setCloud(cs);
    } catch { /* ignore */ }
    setUnlinking(false);
  }, []);

  const handleLogout = useCallback(async () => {
    await api.post("/api/cloud/logout", {});
    setCloud((prev) => prev ? { ...prev, logged_in: false, email: null, linked: false, device_name: null, device_id: null } : null);
  }, []);

  const shareUrl = tunnel?.url || cloud?.tunnel_url;

  return (
    <div className="w-72 bg-background border border-border rounded-lg shadow-lg p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Cloud className="size-4 text-primary" />
          <span className="text-sm font-medium text-foreground">PPM Cloud</span>
        </div>
        <button onClick={onClose} className="text-text-subtle hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
          <Loader2 className="size-4 animate-spin" />
          <span>Loading...</span>
        </div>
      )}

      {!loading && (
        <>
          {/* Cloud Account Section */}
          <div className="space-y-1.5">
            {cloud?.logged_in ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <div className="size-2 rounded-full bg-green-500 shrink-0" />
                  <span className="text-xs text-foreground truncate">{cloud.email}</span>
                </div>
                <button
                  onClick={handleLogout}
                  className="text-text-subtle hover:text-foreground p-1 rounded hover:bg-muted transition-colors shrink-0"
                  title="Sign out"
                >
                  <LogOut className="size-3" />
                </button>
              </div>
            ) : (
              <button
                onClick={handleCloudLogin}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors"
              >
                <Cloud className="size-3.5" />
                Sign in to PPM Cloud
              </button>
            )}
          </div>

          {/* Device Link Section */}
          {cloud?.logged_in && (
            <div className="space-y-1.5">
              {cloud.linked ? (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Link className="size-3 text-primary shrink-0" />
                    <span className="text-foreground truncate">{cloud.device_name}</span>
                  </div>
                  <button
                    onClick={handleUnlink}
                    disabled={unlinking}
                    className="text-text-subtle hover:text-destructive p-1 rounded hover:bg-muted transition-colors shrink-0"
                    title="Unlink device"
                  >
                    {unlinking ? <Loader2 className="size-3 animate-spin" /> : <Unlink className="size-3" />}
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleLink}
                  disabled={linking}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {linking ? (
                    <><Loader2 className="size-3.5 animate-spin" /> Linking...</>
                  ) : (
                    <><Link className="size-3.5" /> Link this machine</>
                  )}
                </button>
              )}
            </div>
          )}

          {/* Separator */}
          <div className="border-t border-border" />

          {/* Local Network URL */}
          {tunnel?.localUrl && (
            <div className="space-y-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Local Network</span>
              <UrlRow url={tunnel.localUrl} copied={copied} onCopy={handleCopy} />
            </div>
          )}

          {/* Tunnel / Share Section */}
          {!shareUrl && !tunnelStarting && (
            <button
              onClick={handleStartTunnel}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Share2 className="size-3.5" />
              Start Sharing
            </button>
          )}

          {tunnelStarting && (
            <div className="flex flex-col items-center gap-2 py-2">
              <Loader2 className="size-5 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground">Starting tunnel...</span>
            </div>
          )}

          {shareUrl && (
            <div className="space-y-1.5">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Public URL</span>
              <div className="flex justify-center">
                <div className="p-3 rounded-lg" style={{ backgroundColor: "#ffffff" }}>
                  <QRCodeSVG value={shareUrl} size={180} bgColor="#ffffff" fgColor="#000000" level="L" />
                </div>
              </div>
              <UrlRow url={shareUrl} copied={copied} onCopy={handleCopy} />
            </div>
          )}

          {/* Cloud Dashboard Link */}
          {cloud?.logged_in && cloud.linked && (
            <a
              href={cloud.cloud_url + "/dashboard"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-md border border-border hover:bg-muted transition-colors"
            >
              <ExternalLink className="size-3" />
              Open Cloud Dashboard
            </a>
          )}

          {/* Error */}
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </>
      )}
    </div>
  );
}

function UrlRow({ url, copied, onCopy }: { url: string; copied: string | null; onCopy: (u: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <input
        readOnly
        value={url}
        className="flex-1 text-xs font-mono text-foreground bg-muted px-2 py-1.5 rounded border border-border truncate"
        onClick={(e) => (e.target as HTMLInputElement).select()}
      />
      <button
        onClick={() => onCopy(url)}
        className="flex items-center justify-center size-7 rounded border border-border text-muted-foreground bg-muted hover:bg-accent hover:text-foreground transition-colors shrink-0"
        title="Copy URL"
      >
        {copied === url ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
