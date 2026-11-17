/**
 * A waiting task's wait as a row shows it: "Waiting on you · Today", "Waiting on Việt · 2d",
 * "Waiting · 5d". A wait on the user stands out (raised hand, accent colour); anyone else's is in
 * the warning colour. Nothing wraps: the words give way with "…", the due date or age never does.
 */
import { Hand } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { ageShort } from "@/lib/ppm-tasks/task-format";
import type { WaitingDetail } from "../../../../shared/ppm-tasks-waiting";
import { TaskDueLabel } from "./task-due-label";

/** The label in full, for a tooltip: "Waiting on Việt for 2d", "Waiting on you, due 2026-11-18". */
export function waitingTitle(detail: WaitingDetail, now: number = Date.now()): string {
  const until = detail.until;
  if (!until) return detail.label;
  return until.kind === "due" ? `${detail.label}, due ${until.dueDate}` : `${detail.label} for ${ageShort(until.since, now)}`;
}

export interface TaskWaitingLabelProps {
  detail: WaitingDetail;
  /** The user's today as `YYYY-MM-DD`, for the due date; the local date by default. */
  today?: string;
  now?: number;
  /** Drop "Waiting on" and keep the name only, for the narrowest rows ("you · 2d"). */
  short?: boolean;
  className?: string;
}

export function TaskWaitingLabel({ detail, today, now, short, className }: TaskWaitingLabelProps) {
  const who = detail.mine ? "me" : detail.name ? "member" : "unknown";
  const words = short && detail.name ? detail.name : detail.label;
  return (
    <span data-task-waiting={who} data-task-waiting-until={detail.until?.kind ?? "none"} title={waitingTitle(detail, now)}
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap",
        detail.mine ? "font-medium text-primary" : "text-warning", className)}>
      {detail.mine && <Hand aria-hidden className="size-3 shrink-0" />}
      <span data-task-waiting-words="" className="min-w-0 truncate">{words}</span>
      {detail.until && (
        <span className="inline-flex shrink-0 items-center gap-1">
          <span aria-hidden className="text-text-3">·</span>
          {detail.until.kind === "due"
            ? <TaskDueLabel dueDate={detail.until.dueDate} today={today} className="text-[length:inherit]" />
            : <span data-task-waiting-age="" className="font-mono text-[0.95em]">{ageShort(detail.until.since, now)}</span>}
        </span>
      )}
    </span>
  );
}
