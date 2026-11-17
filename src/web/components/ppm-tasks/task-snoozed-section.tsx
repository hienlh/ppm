/**
 * The last section of the Tasks list: "Snoozed (N)", folded by default. Open, it lists the tasks
 * out of the daily list until their day or a link change, each with when it comes back and an
 * Unsnooze button; a row still opens its task. The fold is remembered per device.
 */
import type { ReactNode } from "react";
import { ChevronRight, Moon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { useTaskViewStore } from "@/stores/ppm-tasks-view-store";
import type { TaskDto } from "../../../shared/ppm-tasks-api";

export interface TaskSnoozedSectionProps {
  tasks: readonly TaskDto[];
  /** Phone layout: the drawer's full-width header. */
  mobile?: boolean;
  row(task: TaskDto): ReactNode;
}

export function TaskSnoozedSection({ tasks, mobile, row }: TaskSnoozedSectionProps) {
  const open = useTaskViewStore((s) => s.snoozedOpen);
  if (tasks.length === 0) return null;
  return (
    <section data-task-snoozed-section="" data-open={open ? "" : undefined} aria-label="Snoozed tasks" className={cn(mobile ? "pt-2" : "pt-1")}>
      <button type="button" aria-expanded={open} data-task-snoozed-toggle="" onClick={() => useTaskViewStore.getState().setSnoozedOpen(!open)}
        className={cn(
          "flex w-full items-center gap-1.5 text-left font-semibold uppercase tracking-wide text-text-3 hover:text-text-2",
          mobile ? "bg-panel px-4 pb-1 pt-3 text-xs" : "rounded-md px-2 text-[11px]",
          !mobile && TEXT_CONTROL_HEIGHT,
        )}>
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Moon aria-hidden className="size-3.5 shrink-0" />
        Snoozed
        <span className={cn("rounded bg-surface px-1.5 font-mono font-normal", mobile ? "text-[11px]" : "text-[10.5px]")}>{tasks.length}</span>
        {!mobile && <span aria-hidden className="h-px flex-1 bg-border-soft" />}
      </button>
      {open && (
        <div data-task-snoozed-rows="" className={cn(mobile && "divide-y divide-border-soft")}>
          {tasks.map((t) => <div key={t.id}>{row(t)}</div>)}
        </div>
      )}
    </section>
  );
}

/** A row's Unsnooze button (text button: 28px, 26px on a phone). */
export function UnsnoozeButton({ onClick, className }: { onClick(): void; className?: string }) {
  return (
    <button type="button" data-task-unsnooze="" onClick={(e) => { e.stopPropagation(); onClick(); }}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn("inline-flex shrink-0 items-center rounded-full border border-border-soft bg-panel-2 px-2.5 text-[11.5px] text-primary hover:bg-accent-wash max-md:px-[5px]", TEXT_CONTROL_HEIGHT, className)}>
      Unsnooze
    </button>
  );
}
