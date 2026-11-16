/** Importance as three rising bars, filled by level: Must (three), Should (two), Nice to have (one). */
import { cn } from "@/lib/utils";
import { IMPORTANCE_LABEL } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import type { Importance } from "../../../../shared/ppm-tasks";

const FILLED: Record<Importance, { count: number; color: string }> = {
  must: { count: 3, color: "var(--text)" },
  should: { count: 2, color: "var(--text-2)" },
  nice: { count: 1, color: "var(--text-3)" },
};
const HEIGHTS = ["h-[5px]", "h-2", "h-[11px]"];

export interface TaskImportanceBarsProps {
  importance: Importance;
  showLabel?: boolean;
  className?: string;
}

export function TaskImportanceBars({ importance, showLabel = true, className }: TaskImportanceBarsProps) {
  const { count, color } = FILLED[importance];
  const label = IMPORTANCE_LABEL[importance];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-text-2", importance === "must" && "font-medium text-text", className)}
      data-importance={importance} aria-label={showLabel ? undefined : label} title={showLabel ? undefined : label}>
      <span aria-hidden className="inline-flex h-[11px] items-end gap-[1.5px]">
        {HEIGHTS.map((h, i) => (
          <i key={h} className={cn("w-[3px] rounded-[1px]", h)} data-filled={i < count || undefined}
            style={{ background: i < count ? color : "color-mix(in srgb, var(--text) 18%, transparent)" }} />
        ))}
      </span>
      {showLabel ? label : null}
    </span>
  );
}
