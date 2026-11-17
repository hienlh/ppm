/**
 * "Snooze until…": a popover on a desktop, a bottom sheet below `md` (design-guidelines rule 1).
 * `TaskSnoozePicker` is the controlled half the row menu opens beside a row (with a trigger as
 * children, the popover sits beside that instead); `TaskSnoozeButton` is the task page's own
 * button ("Snooze", or "Snoozed · Thu 20 Nov" while it is).
 * The caller writes the patch.
 */
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Popover } from "radix-ui";
import { Moon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { localYmd } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { hasSnooze, shortDay } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { TaskSnoozeOptions, type SnoozePatch, type TaskSnoozeOptionsProps } from "./task-snooze-options";

export interface TaskSnoozePickerProps {
  task: TaskSnoozeOptionsProps["task"];
  open: boolean;
  onOpenChange(open: boolean): void;
  onSnooze(patch: SnoozePatch): void;
  /** What the desktop popover sits beside when it has no trigger of its own (a row). */
  anchorRef?: RefObject<HTMLElement | null>;
  /** The desktop trigger; absent, the popover anchors to `anchorRef`. */
  children?: ReactNode;
  /** Opens on the date field. */
  pickingDate?: boolean;
}

function Heading() {
  return <p className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-text-3 max-md:px-0 max-md:pb-2 max-md:text-[15px] max-md:normal-case max-md:tracking-normal max-md:text-text">Snooze until…</p>;
}

export function TaskSnoozePicker({ task, open, onOpenChange, onSnooze, anchorRef, children, pickingDate }: TaskSnoozePickerProps) {
  const isMobile = useIsMobile();
  const pick = (patch: SnoozePatch) => { onOpenChange(false); onSnooze(patch); };
  if (isMobile) {
    return (
      <>
        {children}
        <BottomSheet open={open} onClose={() => onOpenChange(false)} className="flex max-h-[88%] flex-col">
          {open && (
            <div role="dialog" aria-label="Snooze until" data-task-snooze-sheet="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
              <Heading />
              <TaskSnoozeOptions task={task} onPick={pick} pickingDate={pickingDate} />
            </div>
          )}
        </BottomSheet>
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {children ? <Popover.Anchor asChild>{children}</Popover.Anchor> : <Popover.Anchor virtualRef={anchorRef as RefObject<HTMLElement>} />}
      <Popover.Portal>
        <Popover.Content side="bottom" align="end" sideOffset={6} collisionPadding={8} aria-label="Snooze until" data-task-snooze-popover=""
          // The trigger toggles it itself: its own press must not close it first and reopen it.
          onPointerDownOutside={(e) => { if (anchorRef?.current?.contains(e.target as Node)) e.preventDefault(); }}
          className="z-50 w-[320px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-panel-2 p-1.5 font-sans shadow-lg">
          <Heading />
          <TaskSnoozeOptions task={task} onPick={pick} pickingDate={pickingDate} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The task page's Snooze button: "Snooze", or "Snoozed · Thu 20 Nov" while one is set. */
export function TaskSnoozeButton({ task, onSnooze, className }: {
  task: Pick<TaskDto, "snoozedUntil" | "snoozeUntilChange" | "links" | "baseGroup">; onSnooze(patch: SnoozePatch): void; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (task.baseGroup === "closed") return null;
  const snoozed = hasSnooze(task);
  const label = !snoozed ? "Snooze" : task.snoozedUntil ? `Snoozed · ${shortDay(task.snoozedUntil, localYmd())}` : "Snoozed · until a link changes";
  return (
    <TaskSnoozePicker task={task} open={open} onOpenChange={setOpen} onSnooze={onSnooze} anchorRef={button}>
      <button ref={button} type="button" data-task-snooze-button="" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[11.5px] max-md:px-[5px] [&_svg]:size-3.5",
          TEXT_CONTROL_HEIGHT,
          snoozed ? "border-accent-wash-border bg-accent-wash text-primary" : "border-border-soft bg-panel-2 text-text-2 hover:text-text",
          className,
        )}>
        <Moon aria-hidden />{label}
      </button>
    </TaskSnoozePicker>
  );
}
