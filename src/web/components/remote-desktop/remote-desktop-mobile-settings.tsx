/**
 * The mobile viewer's settings panel — the toggles the desktop keeps in its `Settings2`
 * dropdown, which has no room in a thumb-zone row of 44px buttons.
 *
 * Rendered *in flow* inside the bottom bar rather than through `mobile-bottom-sheet`, exactly
 * like `remote-desktop-mobile-key-bar.tsx`: the viewer already lives in its own full-viewport
 * portal, so a second portal would have to win a z-index argument with it, and a panel in the
 * bottom bar rides that bar's `keyboardInset` lift for free.
 *
 * Scale modes are deliberately absent: pinch-zoom and the toolbar's Reset zoom already own the
 * transform here, and they do it continuously rather than in three fixed steps.
 */
import { useMemo } from "react";
import { Circle, Clipboard, EyeOff, Gauge, Image, MousePointer2, Square, Volume2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { fitLocalMode, localScreenSize, resolutionChoices } from "./remote-desktop-resolution-list";
import type { HostMode } from "./use-remote-desktop-readiness";

export interface RemoteDesktopMobileSettingsProps {
  statsVisible: boolean;
  onToggleStats: () => void;
  showCursor: boolean;
  onSetShowCursor: (show: boolean) => void;
  clipboardEnabled: boolean;
  onSetClipboardEnabled: (enabled: boolean) => void;
  audioOn: boolean;
  /** Why audio cannot be turned on, or null when it can. */
  audioReason: string | null;
  onSetAudioOn: (on: boolean) => void;
  privacyOn: boolean;
  privacyReason: string | null;
  onSetPrivacyOn: (on: boolean) => void;
  /** The host's own display modes, collapsed to one row per size by the panel. Empty on a host
   *  whose resolution cannot be changed, which renders no section at all. */
  hostModes: HostMode[];
  hostModeId: string | null;
  /** The mode the host was on before this session changed it, for the "Original" chip. */
  hostOriginalModeId: string | null;
  onSetHostMode: (modeId: string) => void;
  /** Input injection available. Resizing the host is host control, so a view-only session must
   *  not offer it — RustDesk gates the same submenu on `ffiModel.keyboard`. */
  canResizeHost: boolean;
  resolutionError: string | null;
  recording: boolean;
  recordingSupported: boolean;
  onToggleRecording: () => void;
  onScreenshot: () => void;
}

function SettingRow({
  icon, label, hint, checked, onToggle, testId, disabled,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: () => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      data-testid={testId}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-white/80 active:bg-white/10 disabled:opacity-50"
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{label}</span>
        {hint && <span className="block truncate text-[10px] text-white/45">{hint}</span>}
      </span>
      {/* A drawn switch rather than the `ui/switch` primitive: this panel sits on black inside
          the viewer's own portal, where the themed component's surface colours disappear. */}
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-primary" : "bg-white/20",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-white transition-all",
            checked ? "left-[1.125rem]" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}

export function RemoteDesktopMobileSettings({
  statsVisible, onToggleStats, showCursor, onSetShowCursor,
  clipboardEnabled, onSetClipboardEnabled,
  audioOn, audioReason, onSetAudioOn,
  privacyOn, privacyReason, onSetPrivacyOn,
  hostModes, hostModeId, hostOriginalModeId, onSetHostMode, canResizeHost, resolutionError,
  recording, recordingSupported, onToggleRecording, onScreenshot,
}: RemoteDesktopMobileSettingsProps) {
  const resolutions = useMemo(() => resolutionChoices(hostModes), [hostModes]);
  const localScreen = useMemo(() => localScreenSize(), []);
  const fitLocal = useMemo(
    () => fitLocalMode(hostModes, localScreen, hostModeId),
    [hostModes, localScreen, hostModeId],
  );
  return (
    <div
      className="mx-2 mb-1 space-y-0.5 rounded-xl border border-white/10 bg-black/90 p-1"
      data-testid="remote-desktop-mobile-settings"
    >
      <SettingRow
        icon={<Gauge className="size-4" />}
        label="Quality monitor"
        checked={statsVisible}
        onToggle={onToggleStats}
        testId="remote-desktop-mobile-stats-toggle"
      />
      <SettingRow
        icon={<MousePointer2 className="size-4" />}
        label="Show remote cursor"
        hint="Restarts the stream"
        checked={showCursor}
        onToggle={() => onSetShowCursor(!showCursor)}
        testId="remote-desktop-mobile-cursor-toggle"
      />
      <SettingRow
        icon={<Clipboard className="size-4" />}
        label="Sync clipboard"
        hint="Off: Ctrl+V pastes the host's own clipboard"
        checked={clipboardEnabled}
        onToggle={() => onSetClipboardEnabled(!clipboardEnabled)}
        testId="remote-desktop-mobile-clipboard-toggle"
      />
      {/* The tap on this row is the user gesture the autoplay policy needs to resume the
          `AudioContext`, which is why audio can only ever be started from a control. */}
      <SettingRow
        icon={<Volume2 className="size-4" />}
        label="Play host audio"
        hint={audioReason ?? undefined}
        checked={audioOn}
        disabled={audioReason !== null}
        onToggle={() => onSetAudioOn(!audioOn)}
        testId="remote-desktop-mobile-audio-toggle"
      />
      <SettingRow
        icon={<EyeOff className="size-4" />}
        label="Privacy mode"
        hint={privacyReason ?? "Blocks the host's own keyboard and mouse"}
        checked={privacyOn}
        disabled={privacyReason !== null && !privacyOn}
        onToggle={() => onSetPrivacyOn(!privacyOn)}
        testId="remote-desktop-mobile-privacy-toggle"
      />
      {/* A scrolling list of chips rather than a select: a native `<select>` on a phone opens
          the OS picker *over* the viewer's own portal, and this panel is inside it. */}
      {canResizeHost && resolutions.length > 1 && (
        <div className="px-3 pt-1">
          <div className="pb-1.5 text-[10px] uppercase tracking-wide text-white/40">Resolution</div>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {hostOriginalModeId && hostOriginalModeId !== hostModeId && (
              <button
                type="button"
                onClick={() => onSetHostMode(hostOriginalModeId)}
                data-testid="remote-desktop-mobile-resolution-original"
                className="min-h-9 rounded-md bg-white/10 px-2.5 py-1 text-[11px] text-white/70 active:bg-white/20"
              >
                Original
              </button>
            )}
            {/* A phone's screen is almost never one of the host's advertised sizes, so this chip
                is normally absent — the same as RustDesk on the same pair. */}
            {fitLocal && (
              <button
                type="button"
                onClick={() => onSetHostMode(fitLocal.id)}
                data-testid="remote-desktop-mobile-resolution-fit-local"
                className="min-h-9 rounded-md bg-white/10 px-2.5 py-1 text-[11px] text-white/70 active:bg-white/20"
              >
                Fit local
              </button>
            )}
            {resolutions.map((r) => {
              const active = (hostModeId ?? resolutions.find((c) => c.current)?.id) === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onSetHostMode(r.id)}
                  data-testid={`remote-desktop-mobile-resolution-${r.width}x${r.height}`}
                  className={cn(
                    "min-h-9 rounded-md px-2.5 py-1 text-[11px] tabular-nums",
                    active ? "bg-white/25 text-white" : "bg-white/10 text-white/70 active:bg-white/20",
                  )}
                >
                  {r.width}×{r.height}
                </button>
              );
            })}
          </div>
          {resolutionError && (
            <div className="pt-1.5 text-[10px] leading-tight text-red-400">{resolutionError}</div>
          )}
        </div>
      )}
      {/* Actions, not switches — a plain row each, so the drawn switch is never shown for
          something that does not stay on. */}
      <button
        type="button"
        onClick={onScreenshot}
        data-testid="remote-desktop-mobile-screenshot"
        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-white/80 active:bg-white/10"
      >
        <Image className="size-4 opacity-80" /> Save screenshot
      </button>
      {recordingSupported && (
        <button
          type="button"
          onClick={onToggleRecording}
          data-testid="remote-desktop-mobile-record"
          className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-white/80 active:bg-white/10"
        >
          {recording
            ? <><Square className="size-4 text-red-500" /> Stop recording</>
            : <><Circle className="size-4 opacity-80" /> Start recording</>}
        </button>
      )}
    </div>
  );
}
