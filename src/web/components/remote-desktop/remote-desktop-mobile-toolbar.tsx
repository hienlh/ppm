/**
 * Bottom (thumb-zone) toolbar for the mobile remote-desktop viewer: a Right click chip above a
 * row of Touch/Mouse mode toggle, virtual keyboard, zoom reset, display, quality, More and close.
 * The chip follows rule 3 of `docs/design-guidelines.md` (26px with text on a phone). The row's
 * icon-over-label buttons predate that rule and keep their size; the on/off settings live behind
 * More (`remote-desktop-mobile-settings.tsx`) because the row is `flex-1` per button and gets
 * cramped on a small phone.
 */
import { Hand, MousePointer2, MousePointerClick, Keyboard, ZoomOut, Settings2, Monitor, Wifi, X } from "@/lib/icons";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { cn } from "@/lib/utils";
import type { RemoteDesktopInputMode } from "./use-remote-desktop-touch";

export interface RemoteDesktopMobileToolbarProps {
  /** Current display's name on a multi-monitor host; null hides the button (single display). */
  displayLabel: string | null;
  /** Cycle to the next display — one tap per hop beats a dropdown in the thumb zone. */
  onNextDisplay: () => void;
  /** Short name of the rung being streamed ("Auto", "480p"…) for the quality button's label. */
  qualityLabel: string;
  /** Cycle auto → tiny → low → balanced → high → auto, same one-tap-per-hop reasoning. */
  onNextQuality: () => void;
  mode: RemoteDesktopInputMode;
  onToggleMode: () => void;
  /** The next one-finger tap right-clicks (at the cursor in Mouse mode, at the finger in Touch). */
  rightClickArmed: boolean;
  onToggleRightClick: () => void;
  onOpenKeyboard: () => void;
  onResetZoom: () => void;
  /** Show/hide the settings panel above this row (stats, remote cursor, clipboard sync). */
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onClose: () => void;
}

function ToolbarButton({
  onClick,
  label,
  active,
  children,
}: {
  onClick: () => void;
  label: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[10px]",
        "text-white/80 active:bg-white/10 transition-colors",
        active && "bg-white/15 text-white",
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

export function RemoteDesktopMobileToolbar({
  displayLabel,
  onNextDisplay,
  qualityLabel,
  onNextQuality,
  mode,
  onToggleMode,
  rightClickArmed,
  onToggleRightClick,
  onOpenKeyboard,
  onResetZoom,
  settingsOpen,
  onToggleSettings,
  onClose,
}: RemoteDesktopMobileToolbarProps) {
  return (
    <div className="shrink-0 border-t border-white/10 bg-black/90 px-2 pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-1.5">
      {/* A chip of its own rather than an eighth button in the row below: it is a state the
          user turns on for one tap and watches, so it reads better labelled and lit than as one
          more equal-width icon. */}
      <div className="flex pb-1">
        <button
          type="button"
          onClick={onToggleRightClick}
          aria-pressed={rightClickArmed}
          className={cn(
            TEXT_CONTROL_HEIGHT,
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] max-md:px-[5px] transition-colors",
            rightClickArmed
              ? "border-primary bg-primary text-primary-foreground"
              : "border-white/20 text-white/80 active:bg-white/10",
          )}
          data-testid="remote-desktop-right-click-button"
        >
          <MousePointerClick className="size-3.5" />
          <span>{rightClickArmed ? "Next tap right-clicks" : "Right click"}</span>
        </button>
      </div>
      <div className="flex items-stretch gap-1" data-testid="remote-desktop-mobile-toolbar">
      <ToolbarButton onClick={onToggleMode} label={mode === "mouse" ? "Mouse" : "Touch"} active>
        {mode === "mouse" ? <MousePointer2 className="size-5" /> : <Hand className="size-5" />}
      </ToolbarButton>
      <ToolbarButton onClick={onOpenKeyboard} label="Keyboard">
        <Keyboard className="size-5" />
      </ToolbarButton>
      <ToolbarButton onClick={onResetZoom} label="Reset zoom">
        <ZoomOut className="size-5" />
      </ToolbarButton>
      {displayLabel !== null && (
        <ToolbarButton onClick={onNextDisplay} label={displayLabel.length > 10 ? `${displayLabel.slice(0, 9)}…` : displayLabel}>
          <Monitor className="size-5" />
        </ToolbarButton>
      )}
      <ToolbarButton onClick={onNextQuality} label={qualityLabel}>
        <Wifi className="size-5" />
      </ToolbarButton>
      <ToolbarButton onClick={onToggleSettings} label="More" active={settingsOpen}>
        <Settings2 className="size-5" />
      </ToolbarButton>
      <ToolbarButton onClick={onClose} label="Close">
        <X className="size-5" />
      </ToolbarButton>
      </div>
    </div>
  );
}
