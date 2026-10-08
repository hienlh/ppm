import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * Settings → Design: whether a design opens in a floating window or as a tab. Applies to
 * designs opened from now on; one already open stays where it is.
 */
export function DesignWindowSetting() {
  const enabled = useSettingsStore((s) => s.designWindows);
  return (
    // The whole row is the label, so the 44px target is the row rather than the 36x20 track.
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
      <span className="space-y-1">
        <span className="block text-sm font-medium">Open designs in a window</span>
        <span className="block text-xs leading-relaxed text-text-subtle">
          A design floats over your panels, where you can move it, snap it to the right half or
          minimize it to the status bar. Off: designs open as tabs. On a phone a design is
          always full screen.
        </span>
      </span>
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => useSettingsStore.getState().setDesignWindows(checked)}
        aria-label="Open designs in a window"
      />
    </label>
  );
}
