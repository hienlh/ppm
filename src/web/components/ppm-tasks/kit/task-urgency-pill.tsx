/**
 * Urgency as a coloured pill: Now, Today, This week, Later. `raised` marks an urgency the due date
 * lifted above the stored one ("auto"), so the user can tell PPM raised it, not a person.
 */
import type { CSSProperties } from "react";
import { Clock } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { URGENCY_LABEL } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import type { Urgency } from "../../../../shared/ppm-tasks";

const TONE: Record<Urgency, string> = {
  now: "var(--error)",
  today: "color-mix(in srgb, var(--warning) 72%, var(--text))",
  week: "var(--accent)",
  later: "var(--text-2)",
};

export interface TaskUrgencyPillProps {
  urgency: Urgency;
  /** The due date raised it above the stored urgency. */
  raised?: boolean;
  className?: string;
}

export function TaskUrgencyPill({ urgency, raised = false, className }: TaskUrgencyPillProps) {
  const tone = TONE[urgency];
  const style: CSSProperties = {
    color: tone,
    background: urgency === "later" ? "color-mix(in srgb, var(--text) 7%, transparent)" : `color-mix(in srgb, ${tone} 13%, transparent)`,
  };
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11.5px] font-semibold", className)}
      style={style} data-urgency={urgency} data-raised={raised ? "auto" : undefined}
      title={raised ? "Raised by the due date" : undefined}>
      {URGENCY_LABEL[urgency]}
      {raised ? <Clock className="size-2.5" aria-label="auto" /> : null}
    </span>
  );
}
