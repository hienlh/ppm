/**
 * Status-bar entry point for opening the Remote Desktop window — the smallest available
 * surface for this slice (mirrors how System Monitor is opened from `resource-status-bar.tsx`).
 * Renders nothing when the feature flag is off server-side, so it stays invisible unless
 * `REMOTE_DESKTOP_ENABLED` is explicitly set.
 */
import { memo, useEffect, useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import { api } from "@/lib/api-client";
import { useOpenRemoteDesktop } from "./open-remote-desktop";

interface Capabilities {
  ffmpegAvailable: boolean;
  videoAvailable: boolean;
  inputAvailable: boolean;
  authRequired: boolean;
}

export const RemoteDesktopStatusButton = memo(function RemoteDesktopStatusButton() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const openRemoteDesktop = useOpenRemoteDesktop();

  useEffect(() => {
    let cancelled = false;
    api.get<Capabilities>("/api/remote-desktop/capabilities")
      .then((c) => { if (!cancelled) setCaps(c); })
      .catch(() => { if (!cancelled) setCaps(null); }); // 404 (flag off) or network error — stay hidden
    return () => { cancelled = true; };
  }, []);

  if (!caps?.videoAvailable) return null;

  return (
    <button
      onClick={openRemoteDesktop}
      data-testid="status-bar-remote-desktop"
      aria-label="Open Remote Desktop"
      title={caps.authRequired ? "Open Remote Desktop" : "Open Remote Desktop (enable PPM auth to use this)"}
      className="flex items-center gap-1 px-1 rounded-sm hover:bg-accent/15 transition-colors cursor-pointer text-text-subtle hover:text-text-primary"
    >
      <MonitorSmartphone className="size-[11px]" />
    </button>
  );
});
