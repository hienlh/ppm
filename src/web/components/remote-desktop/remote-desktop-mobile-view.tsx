/**
 * Mobile full-screen remote-desktop viewer: canvas + pinch-zoom/pan stage, gesture engine
 * (`use-remote-desktop-touch`), virtual keyboard, and the bottom toolbar — hosted inside
 * `remote-desktop-mobile-sheet.tsx`'s plain full-viewport portal. Shares the exact WS/nonce/
 * ping/decode connection logic the desktop floating window uses
 * (`use-remote-desktop-connection`), so this is presentation + input wiring only, not a
 * parallel connection implementation.
 */
import { useRef, useState, useCallback } from "react";
import { RotateCw, MonitorX } from "lucide-react";
import { useRemoteDesktopConnection } from "./use-remote-desktop-connection";
import { useRemoteDesktopTouch, type RemoteDesktopInputMode } from "./use-remote-desktop-touch";
import { useRemoteDesktopVirtualKeyboard } from "./use-remote-desktop-virtual-keyboard";
import { RemoteDesktopMobileToolbar } from "./remote-desktop-mobile-toolbar";
import { RemoteDesktopMobileKeyBar } from "./remote-desktop-mobile-key-bar";

export interface RemoteDesktopMobileViewProps {
  onClose: () => void;
}

export default function RemoteDesktopMobileView({ onClose }: RemoteDesktopMobileViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<RemoteDesktopInputMode>("mouse");
  const [keyBarOpen, setKeyBarOpen] = useState(false);

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
  const openKeyboard = useCallback(() => { showKeyboard(); setKeyBarOpen(true); }, [showKeyboard]);

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
        {/* `h-full w-full` here is load-bearing, not decorative: it makes this element's own
            box exactly match `containerRef`'s (rather than shrink-wrapping the canvas), so (1)
            `max-h-full`/`max-w-full` below has a definite ancestor size to resolve against — the
            unsized version of this div let the canvas render at its native capture resolution,
            hugely overflowing the phone screen so only a clipped corner was ever visible (looked
            like "frozen video" — it was decoding fine, just not on screen), and (2) the CSS
            transform's default `transform-origin: 50% 50%` then lands exactly on
            `containerRef`'s center, which is the same point `fractionFromZoomedPoint` assumes —
            a size mismatch here is what made zoomed taps land in the wrong place. */}
        <div className="relative flex h-full w-full items-center justify-center" style={stageStyle}>
          <canvas ref={canvasRef} data-testid="remote-desktop-canvas" className="max-h-full max-w-full outline-none" />
          {mode === "mouse" && virtualCursor && streaming && (
            <div
              className="pointer-events-none absolute rounded-full border-2 border-white bg-primary shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
              style={{
                left: `${virtualCursor.xFrac * 100}%`,
                top: `${virtualCursor.yFrac * 100}%`,
                width: 14,
                height: 14,
                // Counter-scale by 1/zoom: this marker lives inside the zoomed stage, so
                // without this it would grow right along with the video when zoomed in.
                transform: `translate(-50%, -50%) scale(${1 / transform.scale})`,
              }}
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
          onBlur={() => setKeyBarOpen(false)}
          data-testid="remote-desktop-virtual-keyboard-input"
        />
      </div>

      {keyBarOpen && <RemoteDesktopMobileKeyBar sendMessage={sendMessage} />}

      <RemoteDesktopMobileToolbar
        mode={mode}
        onToggleMode={toggleMode}
        onOpenKeyboard={openKeyboard}
        onResetZoom={resetZoom}
        onClose={onClose}
      />
    </div>
  );
}
