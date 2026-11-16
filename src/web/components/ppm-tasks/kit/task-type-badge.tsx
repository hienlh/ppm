/**
 * A task's type: Task, Decision (waiting for the user to decide) or Reply (someone waiting for the
 * user's answer). `tile` draws the icon alone in a tinted square, as list rows use it.
 */
import { ListChecks, Reply, Scale } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { typeLabel } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";

const ICON = { decision: Scale, reply: Reply } as const;
const COLOR: Record<string, string> = { decision: "var(--accent-2)", reply: "var(--info)" };

export interface TaskTypeBadgeProps {
  type: string;
  tile?: boolean;
  className?: string;
}

export function TaskTypeBadge({ type, tile = false, className }: TaskTypeBadgeProps) {
  const Icon = ICON[type as keyof typeof ICON] ?? ListChecks;
  const color = COLOR[type];
  const label = typeLabel(type);
  if (tile) {
    return (
      <span className={cn("grid size-5 shrink-0 place-items-center rounded-md text-text-3", className)} data-task-type={type}
        style={color ? { color, background: `color-mix(in srgb, ${color} 14%, transparent)` } : undefined}
        title={label} aria-label={label}>
        <Icon className="size-3.5" />
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-text-2", className)} data-task-type={type}
      style={color ? { color } : undefined}>
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
