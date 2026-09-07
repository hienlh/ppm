/**
 * Mobile full-screen remote-desktop viewer: canvas + pinch-zoom/pan stage, gesture engine
 * (`use-remote-desktop-touch`), virtual keyboard, and the bottom toolbar — hosted inside
 * `remote-desktop-mobile-sheet.tsx`'s `BottomSheet`. Shares the exact WS/nonce/ping/decode
 * connection logic the desktop floating window uses (`use-remote-desktop-connection`), so this
 * is presentation + input wiring only, not a parallel connection implementation.
 */
import { useRef, useState, useCallback } from "react";
import { RotateCw, MonitorX } from "lucide-react";
import { useRemoteDesktopConnection } from "./use-remote-desktop-connection";
import { useRemoteDesktopTouch, type RemoteDesktopInputMode } from "./use-remote-desktop-touch";
import { useRemoteDesktopVirtualKeyboard } from "./use-remote-desktop-virtual-keyboard";
import { RemoteDesktopMobileToolbar } from "./remote-desktop-mobile-toolbar";

export interface RemoteDesktopMobileViewProps {
  onClose: () => void;
}

export default function RemoteDesktopMobileView({ onClose }: RemoteDesktopMobileViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<RemoteDesktopInputMode>("mouse");

  const { connState, errorMessage, decoderStatus, decoderErrorMessage, sendMessage, reconnect } =
    useRemoteDesktopConnection(canvasRef);
  const streaming = connState === "streaming";

  const { transform, virtualCursor, resetZoom } = useRemoteDesktopTouch({
    containerRef,
    mode,
    sendMessage,
    enabled: streaming,
  });
  const { inputRef: keyboardInputRef, show: showKeyboard } = useRemoteDesktopVirtualKeyboard(sendMessage, streaming);

  const toggleMode = useCallback(() => setMode((m) => (m === "mouse" ? "touch" : "mouse")), []);

  const overlayMessage = decoderStatus === "unsupported"
    ? decoderErrorMessage
    : connState === "error"
      ? errorMessage
      : connState === "closed"
        ? "Disconnected"
        : connState === "connecting"
          ? "Connecting…"
          : null;

  const stageStyle = { transform: `translate(${transform.panX}px, ${transform.panY}px) scale(${transform.scale})` };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-black" data-testid="remote-desktop-mobile-view" data-conn-state={connState}>
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ touchAction: "none" }}
        data-testid="remote-desktop-mobile-stage-container"
      >
        <div className="relative flex items-center justify-center" style={stageStyle}>
          <canvas ref={canvasRef} data-testid="remote-desktop-canvas" className="max-h-full max-w-full outline-none" />
          {mode === "mouse" && virtualCursor && streaming && (
            <div
              className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/30"
              style={{ left: `${virtualCursor.xFrac * 100}%`, top: `${virtualCursor.yFrac * 100}%` }}
              data-testid="remote-desktop-virtual-cursor"
            />
          )}
        </div>

        {overlayMessage && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-sm text-white">
            <MonitorX className="size-6 opacity-70" />
            <span className="max-w-sm px-4 text-center">{overlayMessage}</span>
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

        {/* Hidden input the toolbar's Keyboard button focuses to bring up the soft keyboard —
            kept in normal layout flow (not display:none) since a hidden element cannot receive
            focus, just visually collapsed to nothing. */}
        <input
          ref={keyboardInputRef}
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="absolute size-px opacity-0"
          aria-hidden="true"
          tabIndex={-1}
          data-testid="remote-desktop-virtual-keyboard-input"
        />
      </div>

      <RemoteDesktopMobileToolbar
        mode={mode}
        onToggleMode={toggleMode}
        onOpenKeyboard={showKeyboard}
        onResetZoom={resetZoom}
        onClose={onClose}
      />
    </div>
  );
}
