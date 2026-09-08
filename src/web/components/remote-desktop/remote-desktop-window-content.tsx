/**
 * Remote Desktop window body: thin wrapper around `useRemoteDesktopConnection` (WS/nonce/ping/
 * decode, shared with the mobile viewer) that renders the canvas, overlay states, and wires
 * pointer/keyboard capture over the connection's `sendMessage`. Sits behind
 * `RemoteDesktopWarningGate`, so the connection hook (and its session nonce) only runs once the
 * user has read the warning.
 */
import { useCallback, useRef } from "react";
import { RotateCw, MonitorX, Gauge } from "lucide-react";
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { useWindowStore } from "@/components/floating-window/window-store";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { useRemoteDesktopConnection } from "./use-remote-desktop-connection";
import { useRemoteInputCapture } from "./use-remote-input-capture";
import { RemoteDesktopStatsOverlay } from "./remote-desktop-stats-overlay";
import { RemoteDesktopWarningGate } from "./remote-desktop-warning-gate";
import { RemoteDesktopReadinessGate } from "./remote-desktop-readiness-gate";
import { useRemoteDesktopDisplayChoice } from "./use-remote-desktop-display-choice";

export default function RemoteDesktopWindowContent({ id }: WindowContentProps) {
  const closeWindow = useWindowStore((s) => s.close);
  const onCancel = useCallback(() => closeWindow(id), [closeWindow, id]);
  return (
    <RemoteDesktopWarningGate onCancel={onCancel}>
      <RemoteDesktopReadinessGate onCancel={onCancel}>
        <RemoteDesktopViewer />
      </RemoteDesktopReadinessGate>
    </RemoteDesktopWarningGate>
  );
}

function RemoteDesktopViewer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const display = useRemoteDesktopDisplayChoice();
  const { connState, errorMessage, decoderStatus, decoderErrorMessage, sendMessage, reconnect, getFrameCount, getTotalBytes } =
    useRemoteDesktopConnection(canvasRef, { displayId: display.displayId });
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
      {/* Multi-monitor hosts: pick which display to stream. Left of the stats toggle, same
          corner cluster; a single-display host renders nothing here. */}
      {display.displays.length > 1 && (
        <select
          value={display.current?.id ?? ""}
          onChange={(e) => display.select(e.target.value)}
          aria-label="Display"
          className="absolute right-8 top-1 z-40 h-6 max-w-[45%] rounded bg-black/40 px-1.5 text-xs text-white/80 hover:bg-black/60"
          data-testid="remote-desktop-display-select"
        >
          {display.displays.map((d) => (
            <option key={d.id} value={d.id}>{d.label}{d.primary ? " (main)" : ""} · {d.width}×{d.height}</option>
          ))}
        </select>
      )}
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
