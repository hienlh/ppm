/**
 * A task's snooze at a glance: "Until Thu 20 Nov" (a moon) while it is out of the daily list, or
 * "Back today" on the day it came back. Nothing otherwise. Rows, the task page and the phone page
 * all use it, so the words are the same everywhere.
 */
import { Moon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { localYmd } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { shortDay, snoozeText } from "../../../../shared/ppm-tasks";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";

export interface TaskSnoozeBadgeProps {
  task: Pick<TaskDto, "snoozed" | "resurfacedToday" | "snoozedUntil" | "snoozeUntilChange">;
  /** The day alone ("Wed 18 Nov", "link change"): the moon already says it is a snooze. */
  compact?: boolean;
  className?: string;
}

/** "Until Thu 20 Nov", "Back today", or null; compact, "Thu 20 Nov" or "link change". */
export function snoozeBadgeText(task: TaskSnoozeBadgeProps["task"], today = localYmd(), compact = false): string | null {
  if (task.snoozed && compact) return task.snoozedUntil ? shortDay(task.snoozedUntil, today) : "link change";
  if (task.snoozed) {
    const text = snoozeText(task, today);
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
  }
  return task.resurfacedToday ? "Back today" : null;
}

export function TaskSnoozeBadge({ task, compact, className }: TaskSnoozeBadgeProps) {
  const text = snoozeBadgeText(task, localYmd(), compact);
  if (!text) return null;
  const back = !task.snoozed;
  return (
    <span data-task-snooze={back ? "back" : "snoozed"} title={snoozeBadgeText(task) ?? undefined}
      className={cn("inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-[11.5px]", back ? "font-medium text-warning" : "text-text-3", className)}>
      <Moon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}
