import { cn } from "@/lib/utils";

function loadColor(pct: number): string {
  if (pct > 80) return "bg-error";
  if (pct > 50) return "bg-warning";
  return "bg-success";
}

/** One vertical bar per core, tooltip shows the exact percentage. `min-h-11` keeps the
 *  strip out of sub-44px touch-row territory even though nothing here is clickable —
 *  a future click-to-isolate-core affordance should not need a layout change. */
export function CpuCoreBars({ cores }: { cores: number[] }) {
  return (
    <div
      className="flex items-end gap-0.5 min-h-11 w-full"
      data-testid="sysmon-core-bars"
      data-core-count={cores.length}
    >
      {cores.map((pct, i) => (
        <div
          key={i}
          className="flex-1 h-11 flex items-end rounded-sm overflow-hidden bg-surface-hover"
          title={`Core ${i}: ${pct.toFixed(0)}%`}
        >
          <div
            className={cn("w-full transition-[height]", loadColor(pct))}
            style={{ height: `${Math.max(2, Math.min(100, pct))}%` }}
          />
        </div>
      ))}
    </div>
  );
}
