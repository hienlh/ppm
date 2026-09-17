/**
 * The desktop viewer's toolbar, modelled on RustDesk's: icon buttons that open grouped menus,
 * floating over the video rather than taking layout from it.
 *
 * Structure follows RustDesk's `remote_toolbar.dart` — a **Monitor** menu (only meaningful on a
 * multi-display host, so it renders nothing on a single-monitor one, exactly as RustDesk's
 * does) and a **Display** menu holding the scale modes, image quality, and the toggles. What is
 * absent is absent because the feature behind it does not exist yet, not because it was
 * forgotten: codec choice (the host probes one H.264 encoder and uses it), host resolution,
 * virtual displays, audio/mute, recording and privacy mode.
 *
 * The stats overlay keeps its own one-tap button instead of moving inside the menu where
 * RustDesk keeps it: it is a thing people flick on and off while diagnosing a stream, and
 * burying a frequently-toggled control two clicks deep to match another product's layout would
 * be a regression dressed as parity.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, EyeOff, Gauge, Image, Monitor, Minus, Plus, Settings2, Square } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  QUALITY_PRESETS, QUALITY_PRESET_ORDER, type QualityChoice, type QualityPresetId,
} from "../../../shared/remote-desktop-quality";
import {
  CUSTOM_SCALE_DEBOUNCE_MS, CUSTOM_SCALE_MAX_PERCENT, CUSTOM_SCALE_MIN_PERCENT,
  CUSTOM_SCALE_NUDGE_PERCENT, VIEW_STYLE_LABELS, VIEW_STYLE_ORDER,
  clampCustomScale, clampScalePercent, scalePercentToPos, scalePosToPercent, snapScalePos,
  type ViewStyle,
} from "./remote-desktop-view-style";
import { codecLabel } from "./remote-desktop-codec-labels";
import {
  fitLocalMode, localScreenSize, resolutionChoices, resolutionLabel,
} from "./remote-desktop-resolution-list";
import type { HostMode } from "./use-remote-desktop-readiness";
import type { RemoteDisplay } from "./use-remote-desktop-readiness";

export interface RemoteDesktopToolbarProps {
  displays: RemoteDisplay[];
  currentDisplayId: string | undefined;
  onSelectDisplay: (id: string) => void;

  quality: { preset: QualityPresetId; held: number };
  /** The rung the client has selected, which is what the menu ticks. Distinct from
   *  `quality.preset` (the rung the host confirmed) because `custom` is a choice no preset id
   *  can represent. */
  qualityChoice: QualityChoice;
  onSetQuality: (choice: QualityChoice) => void;
  /** Opens the custom dialog. Selecting "Custom" must not commit anything by itself — the
   *  numbers live in the dialog. */
  onOpenCustomQuality: () => void;

  /** Every encoder the host can really run, preference order; the first is its own default. */
  codecs: string[];
  /** The encoder the host is running, or null while it is on its own first choice. */
  codec: string | null;
  onSetCodec: (encoder: string | null) => void;

  /** The host's own display modes. Empty on a host whose resolution cannot be changed. */
  hostModes: HostMode[];
  /** The mode the host reports as live, or null before it has reported. */
  hostModeId: string | null;
  /** The mode the host was on before this session changed it, for the "Original" item. */
  hostOriginalModeId: string | null;
  onSetHostMode: (modeId: string) => void;
  /** Whether input injection is available. RustDesk gates this whole submenu on
   *  `ffiModel.keyboard`: resizing someone else's screen is host control, so a view-only
   *  session must not be able to do it even though it can read the mode list. */
  canResizeHost: boolean;
  /** Why the last switch failed, or null. Shown inside the submenu rather than as a toast: the
   *  X server refuses a mode per-mode, so the message only means anything next to the list. */
  resolutionError: string | null;

  viewStyle: ViewStyle;
  customScale: number;
  onSetViewStyle: (style: ViewStyle) => void;
  onSetCustomScale: (scale: number) => void;

  showCursor: boolean;
  onSetShowCursor: (show: boolean) => void;

  /** Host audio. `audioReason` is why it cannot be turned on (no loopback device on the host);
   *  non-null disables the item and explains itself rather than hiding it, because "there is no
   *  sound" is otherwise indistinguishable from a bug. */
  audioOn: boolean;
  audioReason: string | null;
  onSetAudioOn: (on: boolean) => void;

  /** Privacy mode: the host's local keyboard and mouse stop working and its monitor goes dark.
   *  `privacyReason` is why it is unavailable *or* why the last engage failed. */
  privacyOn: boolean;
  privacyReason: string | null;
  privacyCanBlank: boolean;
  onSetPrivacyOn: (on: boolean) => void;

  /** Session recording. `recordingSupported` is false only where `MediaRecorder` is absent. */
  recording: boolean;
  recordingElapsedSec: number;
  recordingSupported: boolean;
  onToggleRecording: () => void;
  onScreenshot: () => void;

  clipboardEnabled: boolean;
  onSetClipboardEnabled: (enabled: boolean) => void;

  statsVisible: boolean;
  onToggleStats: () => void;
}

const BUTTON = "flex size-7 shrink-0 items-center justify-center rounded bg-black/40 text-white/70 "
  + "outline-none hover:bg-black/60 hover:text-white data-[state=open]:bg-black/70 data-[state=open]:text-white";

export function RemoteDesktopToolbar({
  displays, currentDisplayId, onSelectDisplay,
  quality, qualityChoice, onSetQuality, onOpenCustomQuality,
  codecs, codec, onSetCodec,
  hostModes, hostModeId, hostOriginalModeId, onSetHostMode, canResizeHost, resolutionError,
  viewStyle, customScale, onSetViewStyle, onSetCustomScale,
  showCursor, onSetShowCursor,
  audioOn, audioReason, onSetAudioOn,
  privacyOn, privacyReason, privacyCanBlank, onSetPrivacyOn,
  recording, recordingElapsedSec, recordingSupported, onToggleRecording, onScreenshot,
  clipboardEnabled, onSetClipboardEnabled,
  statsVisible, onToggleStats,
}: RemoteDesktopToolbarProps) {
  // The server treats "no displayId" as the primary, so the radio group has to resolve the same
  // way or the menu shows nothing selected on a session that never picked explicitly.
  // Memoised: it is a fresh array per call and the menu re-renders on every stats tick.
  const resolutions = useMemo(() => resolutionChoices(hostModes), [hostModes]);
  // RustDesk reads the local screen once and offers the host mode that matches it exactly.
  // `screen` does not change while a session is open, so this is a one-shot read.
  const localScreen = useMemo(() => localScreenSize(), []);
  const fitLocal = useMemo(
    () => fitLocalMode(hostModes, localScreen, hostModeId),
    [hostModes, localScreen, hostModeId],
  );
  // RustDesk's `showOriginalBtn`: only once the session has moved the host off its own mode.
  const showOriginal = Boolean(hostOriginalModeId && hostOriginalModeId !== hostModeId);

  const activeDisplay = currentDisplayId
    ?? displays.find((d) => d.primary)?.id
    ?? displays[0]?.id
    ?? "";

  return (
    <div
      className="absolute right-1 top-1 z-40 flex items-center gap-1"
      data-testid="remote-desktop-toolbar"
    >
      {/* Nothing to choose between on a single-display host. */}
      {displays.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger className={BUTTON} aria-label="Display" title="Display">
            <Monitor className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Display</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={activeDisplay} onValueChange={onSelectDisplay}>
              {displays.map((d) => (
                <DropdownMenuRadioItem key={d.id} value={d.id} data-testid={`remote-desktop-display-${d.id}`}>
                  {d.label}{d.primary ? " (main)" : ""} · {d.width}×{d.height}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          className={BUTTON}
          aria-label="Display settings"
          title="Display settings"
          data-testid="remote-desktop-settings-trigger"
        >
          <Settings2 className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Scale</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={viewStyle}
            onValueChange={(v) => onSetViewStyle(v as ViewStyle)}
          >
            {VIEW_STYLE_ORDER.map((style) => (
              <DropdownMenuRadioItem key={style} value={style} data-testid={`remote-desktop-view-style-${style}`}>
                {VIEW_STYLE_LABELS[style]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {viewStyle === "custom" && <ZoomRow scale={customScale} onSet={onSetCustomScale} />}

          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="remote-desktop-quality-submenu">
              Image quality
              {/* The choice is a ceiling, so a congested link streams *under* it. Saying so is
                  what stops that reading as the menu having been ignored — the alternative is a
                  ticked rung the picture does not match, which is how the old freeze behaved. */}
              {quality.held < 1 && (
                <span className="ml-1.5 text-[10px] opacity-60" data-testid="remote-desktop-quality-held">
                  {Math.round(quality.held * 100)}% — link limited
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuRadioGroup
                value={qualityChoice}
                onValueChange={(v) => (v === "custom" ? onOpenCustomQuality() : onSetQuality(v as QualityChoice))}
              >
                {/* RustDesk's four, in its order, with nothing else: no `auto` rung, because
                    the adaptation always runs beneath whichever of these is chosen. */}
                {QUALITY_PRESET_ORDER.map((id) => (
                  <DropdownMenuRadioItem key={id} value={id} data-testid={`remote-desktop-quality-${id}`}>
                    {QUALITY_PRESETS[id].label}
                  </DropdownMenuRadioItem>
                ))}
                {/* Last, as in RustDesk. It opens the dialog rather than committing, because
                    "custom" without its two numbers is not a setting. */}
                <DropdownMenuRadioItem value="custom" data-testid="remote-desktop-quality-custom">
                  Custom…
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* One encoder means no choice to offer — which is also the ffmpeg-missing case, and
              the readiness gate above has already explained that one. */}
          {codecs.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="remote-desktop-codec-submenu">
                Codec
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                <DropdownMenuRadioGroup
                  value={codec ?? "auto"}
                  onValueChange={(v) => onSetCodec(v === "auto" ? null : v)}
                >
                  <DropdownMenuRadioItem value="auto">
                    Auto · {codecLabel(codecs[0]!)}
                  </DropdownMenuRadioItem>
                  {codecs.map((enc) => (
                    <DropdownMenuRadioItem key={enc} value={enc} data-testid={`remote-desktop-codec-${enc}`}>
                      {codecLabel(enc)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {/* RustDesk's own name for this is "Resolution" (`_ResolutionsMenu`, right here after
              Image quality and Codec), so that is what it is called — calling it anything else
              invites the reading that it changes *this* window rather than the host's screen,
              which is what the scale modes above do.
              One row per size rather than per timing — see `remote-desktop-resolution-list.ts`.
              Absent entirely when the host cannot change its mode (anything but X11 today):
              the reason is informational and belongs nowhere near a menu the user can click. */}
          {canResizeHost && resolutions.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="remote-desktop-resolution-submenu">
                Resolution
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
                {/* RustDesk shows "Original" only once the session has moved the host off it
                    (`isOriginalResolutionSet && !isOriginalResolution`) — otherwise it is a
                    button that does nothing. */}
                {showOriginal && hostOriginalModeId && (
                  <DropdownMenuItem
                    onSelect={() => onSetHostMode(hostOriginalModeId)}
                    data-testid="remote-desktop-resolution-original"
                  >
                    Original
                  </DropdownMenuItem>
                )}
                {/* Absent unless the host advertises this client's screen size *exactly* and is
                    not already on it — see `fitLocalMode`. */}
                {fitLocal && (
                  <DropdownMenuItem
                    onSelect={() => onSetHostMode(fitLocal.id)}
                    data-testid="remote-desktop-resolution-fit-local"
                  >
                    Fit local {fitLocal.width}×{fitLocal.height}
                  </DropdownMenuItem>
                )}
                {/* One divider for both, and only when there is something above it —
                    RustDesk's `_menuDivider` takes the same two flags. */}
                {(showOriginal || fitLocal) && <DropdownMenuSeparator />}
                <DropdownMenuRadioGroup
                  value={hostModeId ?? resolutions.find((r) => r.current)?.id ?? ""}
                  onValueChange={onSetHostMode}
                >
                  {resolutions.map((r) => (
                    <DropdownMenuRadioItem key={r.id} value={r.id} data-testid={`remote-desktop-resolution-${r.width}x${r.height}`}>
                      {resolutionLabel(r)}
                      {r.preferred && <span className="ml-1.5 text-[10px] opacity-60">native</span>}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {resolutionError && (
                  <div className="px-2 py-1.5 text-[10px] leading-tight text-destructive">{resolutionError}</div>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <DropdownMenuSeparator />
          {/* Toggling the cursor respawns the capture (~400ms of held picture), because ffmpeg
              takes `-draw_mouse` at startup and there is no way to retune it on a live process. */}
          <DropdownMenuCheckboxItem
            checked={showCursor}
            onCheckedChange={onSetShowCursor}
            data-testid="remote-desktop-show-cursor"
          >
            Show remote cursor
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={clipboardEnabled}
            onCheckedChange={onSetClipboardEnabled}
            data-testid="remote-desktop-clipboard-toggle"
          >
            Sync clipboard
          </DropdownMenuCheckboxItem>
          {/* Starting audio creates an `AudioContext`, which the autoplay policy only lets
              resume inside a user gesture — this click is that gesture, so it must stay a
              menu item and never move into an effect. */}
          <DropdownMenuCheckboxItem
            checked={audioOn}
            disabled={audioReason !== null}
            onCheckedChange={onSetAudioOn}
            data-testid="remote-desktop-audio-toggle"
          >
            <span className="flex min-w-0 flex-col">
              <span>Play host audio</span>
              {audioReason && <span className="text-[10px] leading-tight text-muted-foreground">{audioReason}</span>}
            </span>
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />
          {/* Last in the list and described in full, because this is the one item that takes
              the host away from whoever is sitting at it. */}
          <DropdownMenuCheckboxItem
            checked={privacyOn}
            disabled={privacyReason !== null && !privacyOn}
            onCheckedChange={onSetPrivacyOn}
            data-testid="remote-desktop-privacy-toggle"
          >
            <span className="flex min-w-0 flex-col">
              <span>Privacy mode</span>
              <span className="text-[10px] leading-tight text-muted-foreground">
                {privacyReason
                  ?? (privacyCanBlank
                    ? "Blocks the host's keyboard and mouse, and blanks its screen"
                    : "Blocks the host's keyboard and mouse (its screen stays on)")}
              </span>
            </span>
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onScreenshot} data-testid="remote-desktop-screenshot">
            <Image className="size-3.5" /> Save screenshot
          </DropdownMenuItem>
          {recordingSupported && (
            <DropdownMenuItem onSelect={onToggleRecording} data-testid="remote-desktop-record">
              {recording
                ? <><Square className="size-3.5 text-red-500" /> Stop recording · {formatElapsed(recordingElapsedSec)}</>
                : <><Circle className="size-3.5" /> Start recording</>}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Visible without opening the menu, and for a stronger reason than recording: the person
          at the host cannot use it right now, and the only way out is from here. */}
      {privacyOn && (
        <button
          type="button"
          onClick={() => onSetPrivacyOn(false)}
          title="Privacy mode is on — click to release the host"
          aria-label="Turn privacy mode off"
          className="flex h-7 shrink-0 items-center gap-1 rounded bg-amber-500/85 px-1.5 text-[10px] font-medium text-black hover:bg-amber-400"
          data-testid="remote-desktop-privacy-indicator"
        >
          <EyeOff className="size-3" /> Host locked
        </button>
      )}
      {/* Visible without opening the menu: a session that is quietly recording has to say so. */}
      {recording && (
        <button
          type="button"
          onClick={onToggleRecording}
          title="Stop recording"
          aria-label="Stop recording"
          className="flex h-7 shrink-0 items-center gap-1 rounded bg-red-600/80 px-1.5 text-[10px] font-medium tabular-nums text-white hover:bg-red-600"
          data-testid="remote-desktop-recording-indicator"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-white" />
          {formatElapsed(recordingElapsedSec)}
        </button>
      )}
      <button
        type="button"
        onClick={onToggleStats}
        aria-label="Toggle stats overlay"
        aria-pressed={statsVisible}
        title="Quality monitor"
        className={cn(BUTTON, statsVisible && "bg-primary/70 text-primary-foreground hover:bg-primary/80")}
      >
        <Gauge className="size-3.5" />
      </button>
    </div>
  );
}

/** `m:ss`, or `h:mm:ss` past an hour. */
function formatElapsed(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = String(totalSec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Zoom stepper, shown only while the custom mode is selected — `e.preventDefault()` on the
 *  item keeps the menu open so the zoom can be nudged more than once per opening. */
/**
 * RustDesk's scale-custom control: `Row([ −, Expanded(slider), + ])` with the percentage painted
 * on the thumb (`_RectValueThumbShape`).
 *
 * Dragging updates the picture immediately but the *pref* is written on a 300ms debounce, the
 * same as RustDesk's `kDebounceCustomScaleDuration` — a drag across the track is hundreds of
 * ticks, and each one would otherwise be a `persistDevicePref` write.
 *
 * The slider's own range is the normalised track position, not the percent: the mapping is
 * piecewise around the pivot, so a percent-valued slider would be linear and put 100% against
 * the left stop. See `remote-desktop-view-style.ts`.
 */
function ZoomRow({ scale, onSet }: { scale: number; onSet: (n: number) => void }) {
  // Local while dragging, so the thumb tracks the finger without waiting for the debounce.
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committed = clampScalePercent(Math.round(clampCustomScale(scale) * 100));
  const pct = dragPercent ?? committed;
  const pos = scalePercentToPos(pct);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = (percent: number) => {
    setDragPercent(percent);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setDragPercent(null); onSet(percent / 100); }, CUSTOM_SCALE_DEBOUNCE_MS);
  };
  const nudge = (direction: 1 | -1) => (e: React.MouseEvent) => {
    e.preventDefault();
    commit(clampScalePercent(pct + direction * CUSTOM_SCALE_NUDGE_PERCENT));
  };
  const btn = "flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent disabled:opacity-40";

  return (
    <div className="px-2 py-1.5" data-testid="remote-desktop-zoom-row">
      <div className="flex items-center gap-1.5">
        <button type="button" className={btn} onClick={nudge(-1)} disabled={pct <= CUSTOM_SCALE_MIN_PERCENT} aria-label="Decrease">
          <Minus className="size-3.5" />
        </button>
        <span className="relative flex-1 py-2.5">
          <input
            type="range"
            min={0}
            max={1}
            // ~1% precision over the whole range, matching RustDesk's `divisions`.
            step={1 / (CUSTOM_SCALE_MAX_PERCENT - CUSTOM_SCALE_MIN_PERCENT)}
            value={pos}
            aria-label="Scale"
            aria-valuetext={`${pct}%`}
            data-testid="remote-desktop-zoom-slider"
            // `e.stopPropagation()`: the dropdown treats keys as typeahead and would close on
            // the arrow keys the slider needs.
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => commit(scalePosToPercent(snapScalePos(Number(e.target.value))))}
            className="h-1 w-full cursor-pointer appearance-none rounded bg-accent accent-primary"
          />
          <span
            className="pointer-events-none absolute top-0 -translate-x-1/2 rounded bg-primary px-1.5 text-[10px] leading-4 tabular-nums text-primary-foreground"
            style={{ left: `${pos * 100}%` }}
            data-testid="remote-desktop-zoom-value"
          >
            {pct}%
          </span>
        </span>
        <button type="button" className={btn} onClick={nudge(1)} disabled={pct >= CUSTOM_SCALE_MAX_PERCENT} aria-label="Increase">
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
