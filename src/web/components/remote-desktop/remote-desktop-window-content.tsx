/**
 * Remote Desktop window body: thin wrapper around `useRemoteDesktopConnection` (WS/nonce/ping/
 * decode, shared with the mobile viewer) that renders the canvas, overlay states, and wires
 * pointer/keyboard capture over the connection's `sendMessage`.
 */
import { useRef } from "react";
import { RotateCw, MonitorX, Gauge } from "lucide-react";
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { useRemoteDesktopConnection } from "./use-remote-desktop-connection";
import { useRemoteInputCapture } from "./use-remote-input-capture";
import { RemoteDesktopStatsOverlay } from "./remote-desktop-stats-overlay";

export default function RemoteDesktopWindowContent(_props: WindowContentProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { connState, errorMessage, decoderStatus, decoderErrorMessage, sendMessage, reconnect, getFrameCount, getTotalBytes } =
    useRemoteDesktopConnection(canvasRef);
  const statsVisible = useSettingsStore((s) => s.remoteDesktopStatsVisible);
  const toggleStats = useSettingsStore((s) => s.toggleRemoteDesktopStatsVisible);

  useRemoteInputCapture(canvasRef, sendMessage, connState === "streaming");

  const overlayMessage = decoderStatus === "unsupported"
    ? decoderErrorMessage
    : connState === "error"
      ? errorMessage
      : connState === "closed"
        ? "Disconnected"
        : connState === "connecting"
          ? "Connecting…"
          : null;

  return (
    <div
      className="relative flex h-full w-full items-center justify-center bg-black"
      data-testid="remote-desktop-window"
      data-conn-state={connState}
    >
      <canvas ref={canvasRef} data-testid="remote-desktop-canvas" className="max-h-full max-w-full outline-none" />
      <RemoteDesktopStatsOverlay canvasRef={canvasRef} getFrameCount={getFrameCount} getTotalBytes={getTotalBytes} />
      {/* Small corner toggle for the stats overlay above — top-right so it never collides with
          the overlay itself (top-left) or the window's own title bar/controls above this body. */}
      <button
        type="button"
        onClick={toggleStats}
        aria-label="Toggle stats overlay"
        aria-pressed={statsVisible}
        className={cn(
          "absolute right-1 top-1 z-40 flex size-6 items-center justify-center rounded bg-black/40 text-white/70 hover:bg-black/60 hover:text-white",
          statsVisible && "bg-primary/70 text-primary-foreground hover:bg-primary/80",
        )}
      >
        <Gauge className="size-3.5" />
      </button>
      {overlayMessage && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-sm text-white">
          <MonitorX className="size-6 opacity-70" />
          <span className="max-w-sm text-center px-4">{overlayMessage}</span>
          {(connState === "error" || connState === "closed") && decoderStatus !== "unsupported" && (
            <button
              onClick={reconnect}
              className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20"
            >
              <RotateCw className="size-3.5" /> Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
