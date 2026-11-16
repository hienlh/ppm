/**
 * The Tasks chip in a manager chat's context row (variant-3 screen 00): "<n> tasks · <k> now",
 * with a red dot while something is in Now. It opens the project's "what to do first" list — a
 * popover above the row on a desktop, a bottom sheet on a phone. A narrow chat drops the words
 * (count, dot and icon stay), like the row's other chips.
 *
 * The chip and its popover are siblings, never one inside the other: the popover is placed
 * against the context row, outside the box that clips the chips (see `footer-popover.tsx`).
 */
import { useRef, useState } from "react";
import { ListTodo } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { FooterPopover } from "@/components/chat/footer-popover";
import { FOOTER_CHIP, HIDE_NARROW } from "@/components/chat/footer-chip";
import type { TaskProjectSummary } from "../../../../shared/ppm-tasks-api";
import { ManagerTasksPopoverList } from "./manager-tasks-popover-list";

/** The chip's accessible name: "Tasks: 9 open, 2 now". */
export const tasksChipLabel = (open: number, now: number): string => `Tasks: ${open} open, ${now} now`;

export function ManagerTasksChip({ summary }: { summary: Pick<TaskProjectSummary, "name" | "open" | "now"> }) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const { name, open: count, now } = summary;
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={tasksChipLabel(count, now)}
        title={`${count} open ${count === 1 ? "task" : "tasks"} · ${now} now`}
        data-manager-tasks-chip={name}
        className={cn(FOOTER_CHIP, "gap-[5px]", now > 0 && "border-error/35 can-hover:hover:border-error/60")}
      >
        {now > 0 && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-error" data-tasks-now-dot="" />}
        <ListTodo className="text-text-3" />
        <b className="font-medium tabular-nums text-text">{count}</b>
        <span className={HIDE_NARROW}>{count === 1 ? "task" : "tasks"}</span>
        {now > 0 && <span className={cn("text-error", HIDE_NARROW)}>· {now} now</span>}
      </button>
      <FooterPopover open={open} onClose={() => setOpen(false)} label="Tasks" anchorRef={chipRef} className="w-[min(100%,520px)]">
        <ManagerTasksPopoverList project={name} total={count} onClose={() => setOpen(false)} />
      </FooterPopover>
    </>
  );
}
