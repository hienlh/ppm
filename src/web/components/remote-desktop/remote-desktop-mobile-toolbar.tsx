/**
 * Bottom (thumb-zone) toolbar for the mobile remote-desktop viewer: Touch/Mouse mode toggle,
 * virtual keyboard, zoom reset, close. Every button is a 44px+ touch target per
 * `docs/design-guidelines.md`'s Mobile-First UI Rules.
 */
import { Hand, MousePointer2, Keyboard, ZoomOut, Gauge, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import type { RemoteDesktopInputMode } from "./use-remote-desktop-touch";

export interface RemoteDesktopMobileToolbarProps {
  mode: RemoteDesktopInputMode;
  onToggleMode: () => void;
  onOpenKeyboard: () => void;
  onResetZoom: () => void;
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
  mode,
  onToggleMode,
  onOpenKeyboard,
  onResetZoom,
  onClose,
}: RemoteDesktopMobileToolbarProps) {
  const statsVisible = useSettingsStore((s) => s.remoteDesktopStatsVisible);
  const toggleStats = useSettingsStore((s) => s.toggleRemoteDesktopStatsVisible);

  return (
    <div
      className="flex shrink-0 items-stretch gap-1 border-t border-white/10 bg-black/90 px-2 pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-1.5"
      data-testid="remote-desktop-mobile-toolbar"
    >
      <ToolbarButton onClick={onToggleMode} label={mode === "mouse" ? "Mouse" : "Touch"} active>
        {mode === "mouse" ? <MousePointer2 className="size-5" /> : <Hand className="size-5" />}
      </ToolbarButton>
      <ToolbarButton onClick={onOpenKeyboard} label="Keyboard">
        <Keyboard className="size-5" />
      </ToolbarButton>
      <ToolbarButton onClick={onResetZoom} label="Reset zoom">
        <ZoomOut className="size-5" />
      </ToolbarButton>
      <ToolbarButton onClick={toggleStats} label="Stats" active={statsVisible}>
        <Gauge className="size-5" />
      </ToolbarButton>
      <ToolbarButton onClick={onClose} label="Close">
        <X className="size-5" />
      </ToolbarButton>
    </div>
  );
}
