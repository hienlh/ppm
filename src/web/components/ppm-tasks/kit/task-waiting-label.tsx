/**
 * A waiting task's wait as a row shows it: "Waiting on you · Today", "Waiting on Việt · 2d",
 * "Waiting · 5d". A wait on the user stands out (raised hand, accent colour); anyone else's is in
 * the warning colour. Nothing wraps. Short of room, the date or age gives way first and on whom
 * last, since on whom is what the row is there to say. In a row whose meta line wraps (`untilApart`), the date or age is an item of its own, so in a
 * narrow column it moves to the next line instead of cutting on whom the task waits.
 */
import type { ReactNode } from "react";
import { Clock, Hand } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { ageShort } from "@/lib/ppm-tasks/task-format";
import { dueView, localYmd } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
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
  /**
   * Draw the date or age as a sibling item rather than inside the label (a clock marks an age), for
   * a meta line that wraps: the label's words then never give way to it.
   */
  untilApart?: boolean;
  className?: string;
}

export function TaskWaitingLabel({ detail, today, now, short, untilApart, className }: TaskWaitingLabelProps) {
  const who = detail.mine ? "me" : detail.name ? "member" : "unknown";
  const words = short && detail.name ? detail.name : detail.label;
  const until = detail.until;
  const when: ReactNode = !until ? null
    : until.kind === "due" ? <TaskDueLabel dueDate={until.dueDate} today={today} className="text-[length:inherit]" />
    : <span data-task-waiting-age="" className="font-mono text-[0.95em]">{ageShort(until.since, now)}</span>;
  const label = (
    <span data-task-waiting={who} data-task-waiting-until={until?.kind ?? "none"} title={waitingTitle(detail, now)}
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap",
        detail.mine ? "font-medium text-primary" : "text-warning", className)}>
      {detail.mine && <Hand aria-hidden className="size-3 shrink-0" />}
      {/* Flex shrinks in proportion to size × factor, so 1:10 still clipped the words a little; at
          1:1000 the date takes the whole cut until it is gone. (A factor under 1 would not do: when
          the factors add up to less than 1, flex leaves part of the overflow unshrunk.) */}
      <span data-task-waiting-words="" className="min-w-0 truncate">{words}</span>
      {until && !untilApart && (
        // One truncating run, separator included: cut down to nothing, it leaves no stray "·".
        <span data-task-waiting-inline-when="" className="min-w-0 shrink-[1000] truncate">
          <span aria-hidden className="text-text-3">· </span>
          {until.kind === "due" ? <InlineDue dueDate={until.dueDate} today={today} /> : when}
        </span>
      )}
    </span>
  );
  if (!untilApart || !when) return label;
  return (
    <>
      {label}
      <span data-task-waiting-when="" title={waitingTitle(detail, now)}
        className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-text-3", className)}>
        {until?.kind === "for" && <Clock aria-hidden className="size-3" />}
        {when}
      </span>
    </>
  );
}

/** A due date inside the label: words only (no calendar), so it can give way with "…"; red when near. */
function InlineDue({ dueDate, today }: { dueDate: string; today?: string }) {
  const view = dueView(dueDate, today ?? localYmd());
  if (!view) return null;
  return (
    <span data-due={view.overdue ? "overdue" : view.soon ? "soon" : "later"} title={dueDate}
      className={cn("font-normal text-text-2", view.soon && "font-medium text-error")}>{view.label}</span>
  );
}
