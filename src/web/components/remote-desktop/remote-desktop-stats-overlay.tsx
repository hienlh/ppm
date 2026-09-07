/**
 * Small, unobtrusive fps/KB-per-s/resolution overlay — shared by the desktop floating window
 * (`remote-desktop-window-content.tsx`) and the mobile full-screen viewer
 * (`remote-desktop-mobile-view.tsx`). Self-gated on `useSettingsStore().remoteDesktopStatsVisible`
 * so both call sites just render it unconditionally; the toggle button on either surface flips
 * that one shared setting.
 *
 * Polls the connection/decoder's ref-backed counters at ~2Hz — not a render dependency on every
 * frame/message, which would defeat the point of keeping them refs.
 */
import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { computeRemoteDesktopStats, type RemoteDesktopStatsSample } from "./remote-desktop-stats";

const POLL_INTERVAL_MS = 500;

export interface RemoteDesktopStatsOverlayProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  getFrameCount: () => number;
  getTotalBytes: () => number;
}

export function RemoteDesktopStatsOverlay({ canvasRef, getFrameCount, getTotalBytes }: RemoteDesktopStatsOverlayProps) {
  const visible = useSettingsStore((s) => s.remoteDesktopStatsVisible);
  const [display, setDisplay] = useState({ fps: 0, kbps: 0, width: 0, height: 0 });
  const lastSampleRef = useRef<RemoteDesktopStatsSample>({ frameCount: 0, totalBytes: 0, atMs: 0 });

  useEffect(() => {
    if (!visible) return;
    lastSampleRef.current = { frameCount: getFrameCount(), totalBytes: getTotalBytes(), atMs: performance.now() };
    const id = setInterval(() => {
      const next: RemoteDesktopStatsSample = { frameCount: getFrameCount(), totalBytes: getTotalBytes(), atMs: performance.now() };
      const { fps, kbps } = computeRemoteDesktopStats(lastSampleRef.current, next);
      lastSampleRef.current = next;
      const canvas = canvasRef.current;
      setDisplay({ fps, kbps, width: canvas?.width ?? 0, height: canvas?.height ?? 0 });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [visible, canvasRef, getFrameCount, getTotalBytes]);

  if (!visible) return null;

  return (
    <div
      className="pointer-events-none absolute left-1 top-1 z-40 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/80"
      data-testid="remote-desktop-stats-overlay"
    >
      {Math.round(display.fps)} fps · {Math.round(display.kbps)} KB/s · {display.width}×{display.height}
    </div>
  );
}
