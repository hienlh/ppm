/** A due date in words ("Overdue 2d", "Today", "Tomorrow", "Fri", "18 Nov"), red when due tomorrow or sooner. */
import { Calendar } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { dueView, localYmd } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";

export interface TaskDueLabelProps {
  dueDate: string | null;
  /** The user's today as `YYYY-MM-DD`; the local date by default. */
  today?: string;
  className?: string;
}

export function TaskDueLabel({ dueDate, today, className }: TaskDueLabelProps) {
  const view = dueView(dueDate, today ?? localYmd());
  if (!view) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] text-text-2", view.soon && "font-medium text-error", className)}
      data-due={view.overdue ? "overdue" : view.soon ? "soon" : "later"} title={dueDate ?? undefined}>
      <Calendar className="size-3" aria-hidden />
      {view.label}
    </span>
  );
}
