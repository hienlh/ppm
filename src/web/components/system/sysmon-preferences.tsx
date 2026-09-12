/**
 * System Monitor preferences — Mission Center's Preferences dialog, reduced to
 * the settings PPM can actually honour.
 *
 * Deliberately NOT here: Mission Center's update interval and graph data-point
 * count. PPM's tick rate is the server's (2 s full, 5 s light) and is shared by
 * every subscriber, so a per-client control over it would either do nothing or
 * change the rate for somebody else's window.
 *
 * Rendered inline under the tab strip rather than in a popover: it is two rows,
 * it has to work identically on a phone, and an inline panel needs no portal, no
 * placement and no separate mobile sheet.
 */
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import type { TempUnit } from "@/lib/temperature";

const UNITS: { id: TempUnit; label: string }[] = [
  { id: "c", label: "°C" },
  { id: "f", label: "°F" },
];

export function SysMonPreferences() {
  const tempUnit = useSettingsStore((s) => s.sysmonTempUnit);
  const setTempUnit = useSettingsStore((s) => s.setSysmonTempUnit);
  const kernelTimes = useSettingsStore((s) => s.sysmonKernelTimes);
  const setKernelTimes = useSettingsStore((s) => s.setSysmonKernelTimes);

  return (
    <div
      className="shrink-0 border-b border-border bg-surface-hover/30 px-3 py-2 space-y-2"
      data-testid="sysmon-preferences"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-text-secondary">Temperature unit</span>
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Temperature unit">
          {UNITS.map((u) => (
            <button
              key={u.id}
              type="button"
              role="radio"
              aria-checked={tempUnit === u.id}
              onClick={() => setTempUnit(u.id)}
              data-testid={`sysmon-pref-temp-${u.id}`}
              className={cn(
                "min-h-11 md:min-h-8 px-3 text-xs rounded-md border transition-colors",
                tempUnit === u.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border hover:bg-surface-hover",
              )}
            >
              {u.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <label htmlFor="sysmon-pref-kernel" className="text-xs text-text-secondary">
          Show kernel times on the CPU graph
        </label>
        <button
          id="sysmon-pref-kernel"
          type="button"
          role="switch"
          aria-checked={kernelTimes}
          onClick={() => setKernelTimes(!kernelTimes)}
          data-testid="sysmon-pref-kernel"
          className={cn(
            "min-h-11 md:min-h-8 px-3 text-xs rounded-md border transition-colors",
            kernelTimes
              ? "border-primary bg-primary/10 text-primary"
              : "border-border hover:bg-surface-hover",
          )}
        >
          {kernelTimes ? "On" : "Off"}
        </button>
      </div>

      <p className="text-[11px] text-text-subtle">
        These apply to this device only — the machine being watched is the same for everyone.
      </p>
    </div>
  );
}
