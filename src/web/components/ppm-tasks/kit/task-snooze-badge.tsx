/**
 * A task's snooze at a glance: "Until Thu 20 Nov" (a moon) while it is out of the daily list, or
 * "Back today" on the day it came back. Nothing otherwise. Rows, the task page and the phone page
 * all use it, so the words are the same everywhere.
 */
import { Moon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { localYmd } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { snoozeText } from "../../../../shared/ppm-tasks";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";

export interface TaskSnoozeBadgeProps {
  task: Pick<TaskDto, "snoozed" | "resurfacedToday" | "snoozedUntil" | "snoozeUntilChange">;
  className?: string;
}

/** "Until Thu 20 Nov", "Back today", or null. */
export function snoozeBadgeText(task: TaskSnoozeBadgeProps["task"], today = localYmd()): string | null {
  if (task.snoozed) {
    const text = snoozeText(task, today);
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
  }
  return task.resurfacedToday ? "Back today" : null;
}

export function TaskSnoozeBadge({ task, className }: TaskSnoozeBadgeProps) {
  const text = snoozeBadgeText(task);
  if (!text) return null;
  const back = !task.snoozed;
  return (
    <span data-task-snooze={back ? "back" : "snoozed"}
      className={cn("inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-[11.5px]", back ? "font-medium text-warning" : "text-text-3", className)}>
      <Moon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}
