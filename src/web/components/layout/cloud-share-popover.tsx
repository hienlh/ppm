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
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verifyUrl: string } | null>(null);
  const [loginPolling, setLoginPolling] = useState(false);

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
    setError(null);
    try {
      const { cloud_url } = await api.get<{ url: string; cloud_url: string }>("/api/cloud/login-url");

      // Step 1: Request device code from cloud
      const res = await fetch(`${cloud_url}/auth/device-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to get device code");

      const data = await res.json() as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        expires_in: number;
        interval: number;
      };

      setDeviceCode({ userCode: data.user_code, verifyUrl: data.verification_uri });
      setLoginPolling(true);

      // Step 2: Poll until user completes verification
      const pollInterval = (data.interval || 5) * 1000;
      const deadline = Date.now() + data.expires_in * 1000;

      const poll = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(poll);
          setLoginPolling(false);
          setDeviceCode(null);
          setError("Login expired. Try again.");
          return;
        }
        try {
          const pollRes = await fetch(`${cloud_url}/auth/device-code/poll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_code: data.device_code }),
          });
          if (!pollRes.ok) return;
          const result = await pollRes.json() as { status: string; access_token?: string; email?: string };

          if (result.status === "approved" && result.access_token && result.email) {
            clearInterval(poll);
            setLoginPolling(false);
            setDeviceCode(null);
            // Save auth to PPM server
            await api.post("/api/cloud/login", {
              access_token: result.access_token,
              email: result.email,
              cloud_url,
            });
            const cs = await api.get<CloudStatus>("/api/cloud/status");
            setCloud(cs);
          }
        } catch { /* keep polling */ }
      }, pollInterval);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start login");
      setLoginPolling(false);
      setDeviceCode(null);
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
    if (!confirm("Unlink this device from PPM Cloud? It will no longer appear on your cloud dashboard.")) return;
    setUnlinking(true);
    try {
      await api.post("/api/cloud/unlink", {});
      const cs = await api.get<CloudStatus>("/api/cloud/status");
      setCloud(cs);
    } catch { /* ignore */ }
    setUnlinking(false);
  }, []);

  const handleLogout = useCallback(async () => {
    const msg = cloud?.linked
      ? "Sign out from PPM Cloud? This will also unlink your device."
      : "Sign out from PPM Cloud?";
    if (!confirm(msg)) return;
    if (cloud?.linked) {
      try { await api.post("/api/cloud/unlink", {}); } catch {}
    }
    await api.post("/api/cloud/logout", {});
    setCloud((prev) => prev ? { ...prev, logged_in: false, email: null, linked: false, device_name: null, device_id: null } : null);
  }, [cloud?.linked]);

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
            ) : deviceCode ? (
              <div className="space-y-2 text-center">
                <p className="text-xs text-muted-foreground">Open the link below and enter the code:</p>
                <div className="font-mono text-2xl font-bold tracking-[0.3em] text-primary">{deviceCode.userCode}</div>
                <a
                  href={deviceCode.verifyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  {deviceCode.verifyUrl}
                </a>
                {loginPolling && (
                  <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    <span>Waiting for verification...</span>
                  </div>
                )}
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
                <div className="p-3 rounded-lg" style={{ backgroundColor: "#ffffff", colorScheme: "light" }}>
                  <QRCodeSVG value={shareUrl} size={180} bgColor="#ffffff" fgColor="#000000" level="L" style={{ display: "block" }} />
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
