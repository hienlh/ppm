/**
 * Mobile full-screen remote-desktop viewer: canvas + pinch-zoom/pan stage, gesture engine
 * (`use-remote-desktop-touch`), virtual keyboard, and the bottom toolbar — hosted inside
 * `remote-desktop-mobile-sheet.tsx`'s plain full-viewport portal. Shares the exact WS/nonce/
 * ping/decode connection logic the desktop floating window uses
 * (`use-remote-desktop-connection`), so this is presentation + input wiring only, not a
 * parallel connection implementation.
 */
import { useRef, useState, useCallback } from "react";
import { RotateCw, MonitorX } from "@/lib/icons";
import { useVisualViewport } from "@/hooks/use-visual-viewport";
import { useSettingsStore } from "@/stores/settings-store";
import { useRemoteDesktopConnection } from "./use-remote-desktop-connection";
import { useRemoteDesktopTouch, type RemoteDesktopInputMode } from "./use-remote-desktop-touch";
import { useRemoteDesktopVirtualKeyboard } from "./use-remote-desktop-virtual-keyboard";
import { RemoteDesktopMobileToolbar } from "./remote-desktop-mobile-toolbar";
import {
  nextQualityChoice, shortQualityLabel, type QualityChoice,
} from "../../../shared/remote-desktop-quality";
import { RemoteDesktopMobileKeyBar } from "./remote-desktop-mobile-key-bar";
import { RemoteDesktopMobileSettings } from "./remote-desktop-mobile-settings";
import { useRemoteDesktopRecorder } from "./use-remote-desktop-recorder";
import { saveCanvasScreenshot } from "./remote-desktop-recording";
import { RemoteDesktopStatsOverlay } from "./remote-desktop-stats-overlay";
import { letterboxedContentRect } from "./remote-desktop-coords";
import { useRemoteDesktopDisplayChoice } from "./use-remote-desktop-display-choice";
import { RemoteDesktopClipboardNotice } from "./remote-desktop-clipboard-notice";
import { useRemoteDesktopReadiness } from "./use-remote-desktop-readiness";

export interface RemoteDesktopMobileViewProps {
  onClose: () => void;
}

export default function RemoteDesktopMobileView({ onClose }: RemoteDesktopMobileViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<RemoteDesktopInputMode>("mouse");
  const [keyBarOpen, setKeyBarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const display = useRemoteDesktopDisplayChoice();

  const {
    connState, errorMessage, decoderStatus, decoderErrorMessage, sendMessage, reconnect,
    getTotalBytes, getFrameCount, quality, setQuality, showCursor, setShowCursor,
    audioOn, setAudioOn, getAudioTracks, privacyOn, privacyError, setPrivacyOn,
    hostModeId, hostOriginalModeId, resolutionError, setHostMode,
    pendingHostClipboard, clearHostClipboard, sendClipboard, requestHostClipboard,
  } = useRemoteDesktopConnection(canvasRef, { displayId: display.displayId });
  const statsVisible = useSettingsStore((s) => s.remoteDesktopStatsVisible);
  const toggleStats = useSettingsStore((s) => s.toggleRemoteDesktopStatsVisible);
  const clipboardSync = useSettingsStore((s) => s.remoteDesktopClipboardSync);
  const setClipboardSync = useSettingsStore((s) => s.setRemoteDesktopClipboardSync);
  const qualityChoice = useSettingsStore((st) => st.remoteDesktopQuality);
  const streaming = connState === "streaming";

  const { transform, virtualCursor, resetZoom } = useRemoteDesktopTouch({
    containerRef,
    canvasRef,
    mode,
    sendMessage,
    enabled: streaming,
  });
  // A phone paste goes through the *host clipboard* rather than being typed character by
  // character: typing is subject to the host's IME (a Telex host rewrites "World" as "ửold"),
  // and a pasted URL or token is exactly the text that must survive verbatim. The server falls
  // back to typing by itself when the host has no clipboard tool.
  const [pasteAttempted, setPasteAttempted] = useState(false);
  // Undefined with sync off, which is how the toggle is implemented on this surface: the
  // virtual keyboard then lets the `paste` event's own default action stand (i.e. nothing
  // leaves the device), and the key bar's Ctrl+V button still pastes the *host's* clipboard.
  const onPasteText = useCallback((text: string) => {
    setPasteAttempted(true);
    sendClipboard(text, true);
  }, [sendClipboard]);
  // One fetch, no polling — read only to explain a paste that had to fall back to typing, and
  // an audio toggle the host cannot honour.
  const { caps } = useRemoteDesktopReadiness(false);
  const recorder = useRemoteDesktopRecorder(canvasRef, getAudioTracks);
  const { inputRef: keyboardInputRef, show: showKeyboard } =
    useRemoteDesktopVirtualKeyboard(sendMessage, streaming, clipboardSync ? onPasteText : undefined);

  // Lifts the toolbar/key-bar row above the on-screen keyboard instead of the whole sheet
  // shrinking to make room for it (that was the previous, since-reverted behavior — see
  // remote-desktop-mobile-sheet.tsx's header comment for why it was wrong here).
  const viewportInsets = useVisualViewport(true);
  const keyboardInset = viewportInsets?.keyboardInset ?? 0;

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

  // Positions the virtual-cursor marker (mouse mode) at the video's actual displayed pixel,
  // not a raw percentage of the stage — the canvas is letterboxed (object-contain) inside the
  // stage whenever the capture's aspect ratio doesn't match the phone's, so a naive `left:
  // xFrac*100%` would land inside the letterbox bars instead of on the video. Mirrors exactly
  // what the gesture engine does for hit-testing (`letterboxedContentRect`), just forward
  // instead of inverse. Reading layout here (not in an effect) is fine: it only feeds a cosmetic
  // overlay position, recomputed on every render the cursor itself changes, which already
  // happens on every drag frame.
  let cursorLeft = `${(virtualCursor?.xFrac ?? 0.5) * 100}%`;
  let cursorTop = `${(virtualCursor?.yFrac ?? 0.5) * 100}%`;
  if (virtualCursor && containerRef.current && canvasRef.current?.width && canvasRef.current.height) {
    const box = containerRef.current.getBoundingClientRect();
    const videoRect = letterboxedContentRect({ left: 0, top: 0, width: box.width, height: box.height }, canvasRef.current.width, canvasRef.current.height);
    cursorLeft = `${videoRect.left + virtualCursor.xFrac * videoRect.width}px`;
    cursorTop = `${videoRect.top + virtualCursor.yFrac * videoRect.height}px`;
  }

  return (
    <div className="relative h-full w-full bg-black" data-testid="remote-desktop-mobile-view" data-conn-state={connState}>
      {/* Shrinks to the space above the on-screen keyboard (`bottom: keyboardInset`) so the
          whole desktop stays visible, just smaller — `object-contain` on the canvas then
          refits the video into whatever's left, same as it does for the bottom toolbar/notch
          insets on a normal phone. `top:0` + explicit `bottom` (not `inset-0`) is what lets
          `bottom` do that shrinking; gesture hit-testing already reads this element's own
          `getBoundingClientRect()` fresh per gesture, so it stays correct as the box resizes. */}
      <div
        ref={containerRef}
        className="absolute inset-x-0 top-0 flex items-center justify-center overflow-hidden"
        style={{ touchAction: "none", bottom: keyboardInset }}
        data-testid="remote-desktop-mobile-stage-container"
      >
        {/* `h-full w-full` on both this stage and the canvas below is load-bearing: it gives
            the canvas a definite box to be letterboxed within (`object-contain` needs one), and
            keeps the CSS transform's default `transform-origin: 50% 50%` exactly at this
            container's center — the same point `fractionFromZoomedPoint` assumes. `min-h-0
            min-w-0` on the canvas defeats the flex-item automatic-minimum-size floor (a
            well-known flexbox gotcha for replaced elements): without it, a flex item's implicit
            `min-height/width: auto` can hold the canvas at its intrinsic capture resolution
            despite `height/width: 100%`, which is what made the video render oversized and get
            clipped instead of actually shrinking to fit. */}
        <div className="relative flex h-full w-full items-center justify-center" style={stageStyle}>
          <canvas
            ref={canvasRef}
            data-testid="remote-desktop-canvas"
            className="block h-full w-full min-h-0 min-w-0 object-contain outline-none"
          />
          {mode === "mouse" && virtualCursor && streaming && (
            <div
              className="pointer-events-none absolute rounded-full border-2 border-white bg-primary shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
              style={{
                left: cursorLeft,
                top: cursorTop,
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

      {/* Floats above the on-screen keyboard via `keyboardInset` instead of the sheet shrinking
          to make room — `translateY` rather than `bottom` so it animates smoothly and needs no
          extra reflow. Sits at the true bottom (translateY(0)) once the keyboard is closed. */}
      <div
        className="absolute inset-x-0 bottom-0"
        style={keyboardInset > 0 ? { transform: `translateY(-${keyboardInset}px)` } : undefined}
        data-testid="remote-desktop-mobile-bottom-bar"
      >
        {/* In flow above the key bar so it rides the same `keyboardInset` lift and is never
            hidden behind the toolbar. */}
        <RemoteDesktopClipboardNotice
          pendingText={pendingHostClipboard}
          onDismiss={clearHostClipboard}
          missingToolAction={pasteAttempted && caps && !caps.clipboard.available ? caps.clipboard.action : null}
          onDismissMissingTool={() => setPasteAttempted(false)}
          positionClassName="mx-2 mb-1 max-w-[calc(100%-1rem)]"
        />
        {settingsOpen && (
          <RemoteDesktopMobileSettings
            statsVisible={statsVisible}
            onToggleStats={toggleStats}
            showCursor={showCursor}
            onSetShowCursor={setShowCursor}
            clipboardEnabled={clipboardSync}
            onSetClipboardEnabled={setClipboardSync}
            audioOn={audioOn}
            audioReason={caps && !caps.audio.available ? caps.audio.reason : null}
            onSetAudioOn={setAudioOn}
            privacyOn={privacyOn}
            privacyReason={privacyError ?? (caps && !caps.privacy.available ? caps.privacy.reason : null)}
            hostModes={caps?.resolutions?.modes ?? []}
            hostModeId={hostModeId}
            hostOriginalModeId={hostOriginalModeId}
            onSetHostMode={setHostMode}
            canResizeHost={caps?.inputReady ?? false}
            resolutionError={resolutionError}
            onSetPrivacyOn={setPrivacyOn}
            recording={recorder.recording}
            recordingSupported={recorder.supported}
            onToggleRecording={recorder.toggle}
            onScreenshot={() => void saveCanvasScreenshot(canvasRef.current)}
          />
        )}
        {keyBarOpen && (
          <RemoteDesktopMobileKeyBar
            sendMessage={sendMessage}
            onCopyCombo={clipboardSync ? requestHostClipboard : undefined}
          />
        )}
        <RemoteDesktopMobileToolbar
          displayLabel={display.displays.length > 1 ? display.current?.label ?? null : null}
          onNextDisplay={display.next}
          qualityLabel={shortQualityLabel(qualityChoice)}
          onNextQuality={() => setQuality(nextQualityChoice(qualityChoice))}
          mode={mode}
          onToggleMode={toggleMode}
          onOpenKeyboard={openKeyboard}
          onResetZoom={resetZoom}
          settingsOpen={settingsOpen}
          onToggleSettings={() => setSettingsOpen((open) => !open)}
          onClose={onClose}
        />
      </div>

      {/* Pushed below the app's top-left device-name pill + the notch safe-area (they overlap a
          plain top-1 position on the phone). */}
      <RemoteDesktopStatsOverlay
        canvasRef={canvasRef}
        getFrameCount={getFrameCount}
        getTotalBytes={getTotalBytes}
        positionClassName="left-1 top-[calc(env(safe-area-inset-top,0px)+2.75rem)]"
      />
    </div>
  );
}
