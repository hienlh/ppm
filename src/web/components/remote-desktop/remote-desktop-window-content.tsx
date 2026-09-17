/**
 * Remote Desktop window body: thin wrapper around `useRemoteDesktopConnection` (WS/nonce/ping/
 * decode, shared with the mobile viewer) that renders the canvas, overlay states, and wires
 * pointer/keyboard capture over the connection's `sendMessage`. Sits behind
 * `RemoteDesktopWarningGate`, so the connection hook (and its session nonce) only runs once the
 * user has read the warning.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { RotateCw, MonitorX } from "@/lib/icons";
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
import { RemoteDesktopClipboardNotice } from "./remote-desktop-clipboard-notice";
import { useRemoteDesktopReadiness } from "./use-remote-desktop-readiness";
import { RemoteDesktopToolbar } from "./remote-desktop-toolbar";
import { canvasCssSize } from "./remote-desktop-view-style";
import { useRemoteDesktopRecorder } from "./use-remote-desktop-recorder";
import { saveCanvasScreenshot } from "./remote-desktop-recording";
import { RemoteDesktopCustomQualityDialog } from "./remote-desktop-custom-quality-dialog";

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
  const {
    connState, errorMessage, decoderStatus, decoderErrorMessage, sendMessage, reconnect,
    getFrameCount, getTotalBytes, frameSize, quality, setQuality, setCustomQuality,
    showCursor, setShowCursor,
    codec, setCodec, audioOn, setAudioOn, getAudioTracks,
    privacyOn, privacyError, setPrivacyOn,
    hostModeId, hostOriginalModeId, resolutionError, setHostMode,
    pendingHostClipboard, clearHostClipboard, sendClipboard, requestHostClipboard,
  } = useRemoteDesktopConnection(canvasRef, { displayId: display.displayId });
  const statsVisible = useSettingsStore((s) => s.remoteDesktopStatsVisible);
  const toggleStats = useSettingsStore((s) => s.toggleRemoteDesktopStatsVisible);
  const viewStyle = useSettingsStore((s) => s.remoteDesktopViewStyle);
  const customScale = useSettingsStore((s) => s.remoteDesktopCustomScale);
  const setViewStyle = useSettingsStore((s) => s.setRemoteDesktopViewStyle);
  const setCustomScale = useSettingsStore((s) => s.setRemoteDesktopCustomScale);
  const clipboardSync = useSettingsStore((s) => s.remoteDesktopClipboardSync);
  const qualityChoice = useSettingsStore((s) => s.remoteDesktopQuality);
  const customPercent = useSettingsStore((s) => s.remoteDesktopCustomQualityPercent);
  const customFps = useSettingsStore((s) => s.remoteDesktopCustomFps);
  const customMore = useSettingsStore((s) => s.remoteDesktopCustomQualityMore);
  const setCustomMore = useSettingsStore((s) => s.setRemoteDesktopCustomQualityMore);
  const [customQualityOpen, setCustomQualityOpen] = useState(false);
  const setClipboardSync = useSettingsStore((s) => s.setRemoteDesktopClipboardSync);
  // One fetch, no polling: this is read only to explain a clipboard that cannot work. The
  // readiness *gate* above already cleared, so nothing here is allowed to block the viewer.
  const { caps } = useRemoteDesktopReadiness(false);
  const [pasteAttempted, setPasteAttempted] = useState(false);

  // Stable object: `useRemoteInputCapture` lists it as an effect dependency, so a fresh literal
  // per render would re-bind every canvas listener on every render.
  //
  // Undefined with sync off, which is the whole implementation of the toggle: the hook then
  // stops exempting Ctrl+V from `preventDefault` and forwards it as an ordinary keystroke, so
  // the host pastes its *own* clipboard and no text crosses the connection either way.
  const clipboardHooks = useMemo(() => (clipboardSync ? {
    onPasteText: (text: string, shift: boolean) => { setPasteAttempted(true); sendClipboard(text, true, shift); },
    onCopyCombo: requestHostClipboard,
  } : undefined), [clipboardSync, sendClipboard, requestHostClipboard]);

  useRemoteInputCapture(canvasRef, sendMessage, connState === "streaming", clipboardHooks);

  // The recorder muxes the session audio in when it is playing, so one file carries both.
  const recorder = useRemoteDesktopRecorder(canvasRef, getAudioTracks);

  // null in `adaptive` (and before the first frame): the canvas keeps its `max-*-full` classes
  // and the browser fits it, which is the path this viewer has always been on.
  const cssSize = canvasCssSize(viewStyle, customScale, frameSize);

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
      {/* The scroll container is a child rather than this root, because the overlays below are
          absolutely positioned against the root — inside a scroller they would scroll away with
          the picture. `m-auto` on the canvas rather than `justify-center` on the box: centring
          an oversized child with `justify-content` puts half the overflow *before* the scroll
          origin, where no scrollbar can reach it (the top-left of a 1:1 3440×1440 capture in a
          small window). Auto margins collapse to 0 when the child overflows, so both work. */}
      <div className={cn("flex h-full w-full", cssSize ? "overflow-auto" : "overflow-hidden")}>
        <canvas
          ref={canvasRef}
          data-testid="remote-desktop-canvas"
          data-view-style={viewStyle}
          className={cn("m-auto outline-none", !cssSize && "max-h-full max-w-full")}
          style={cssSize ? { width: cssSize.width, height: cssSize.height } : undefined}
        />
      </div>
      <RemoteDesktopStatsOverlay canvasRef={canvasRef} getFrameCount={getFrameCount} getTotalBytes={getTotalBytes} />
      <RemoteDesktopToolbar
        displays={display.displays}
        currentDisplayId={display.current?.id}
        onSelectDisplay={display.select}
        quality={quality}
        qualityChoice={qualityChoice}
        onSetQuality={setQuality}
        onOpenCustomQuality={() => setCustomQualityOpen(true)}
        codecs={caps?.encoders ?? []}
        codec={codec}
        onSetCodec={setCodec}
        hostModes={caps?.resolutions?.modes ?? []}
        hostModeId={hostModeId}
        hostOriginalModeId={hostOriginalModeId}
        onSetHostMode={setHostMode}
        canResizeHost={caps?.inputReady ?? false}
        resolutionError={resolutionError}
        viewStyle={viewStyle}
        customScale={customScale}
        onSetViewStyle={setViewStyle}
        onSetCustomScale={setCustomScale}
        showCursor={showCursor}
        onSetShowCursor={setShowCursor}
        audioOn={audioOn}
        audioReason={caps && !caps.audio.available ? caps.audio.reason : null}
        onSetAudioOn={setAudioOn}
        privacyOn={privacyOn}
        privacyReason={privacyError ?? (caps && !caps.privacy.available ? caps.privacy.reason : null)}
        privacyCanBlank={caps?.privacy?.canBlank ?? false}
        onSetPrivacyOn={setPrivacyOn}
        recording={recorder.recording}
        recordingElapsedSec={recorder.elapsedSec}
        recordingSupported={recorder.supported}
        onToggleRecording={recorder.toggle}
        onScreenshot={() => void saveCanvasScreenshot(canvasRef.current)}
        clipboardEnabled={clipboardSync}
        onSetClipboardEnabled={setClipboardSync}
        statsVisible={statsVisible}
        onToggleStats={toggleStats}
      />
      {/* Only after a real paste attempt: a host with no clipboard tool is not worth a warning
          until the user actually reaches for it. */}
      <RemoteDesktopClipboardNotice
        pendingText={pendingHostClipboard}
        onDismiss={clearHostClipboard}
        missingToolAction={pasteAttempted && caps && !caps.clipboard.available ? caps.clipboard.action : null}
        onDismissMissingTool={() => setPasteAttempted(false)}
      />
      <RemoteDesktopCustomQualityDialog
        open={customQualityOpen}
        onOpenChange={setCustomQualityOpen}
        percent={customPercent}
        fps={customFps}
        more={customMore}
        onSetMore={setCustomMore}
        onCommit={setCustomQuality}
        frameSize={frameSize}
      />
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
