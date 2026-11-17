/**
 * The "Snooze until…" choices as a list: Tomorrow, 1 week, Pick a date… (opens a date field in
 * place, saved with Snooze), Until a link changes (off without a Jira or PR link), and Unsnooze
 * while the task is snoozed. Drawn inside the desktop popover and the phone bottom sheet; the
 * caller writes the patch and closes.
 */
import { useState } from "react";
import { CalendarClock, Check, Link, Moon, Sun } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { localYmd } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { isSnoozeDay, snoozeChoices, snoozeUntilPatch, type SnoozeChoiceId } from "@/lib/ppm-tasks/task-snooze-choices";
import { addDaysYmd, type TaskPatch } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";

export type SnoozePatch = Pick<TaskPatch, "snoozedUntil" | "snoozeUntilChange">;

export interface TaskSnoozeOptionsProps {
  task: Pick<TaskDto, "snoozedUntil" | "snoozeUntilChange" | "links" | "baseGroup">;
  onPick(patch: SnoozePatch): void;
  /** The user's today; the local date by default. */
  today?: string;
  /** Opens on the date field (the row menu's "Pick a date…" was the choice already). */
  pickingDate?: boolean;
}

const ICONS: Record<SnoozeChoiceId, typeof Moon> = { tomorrow: Sun, week: Moon, date: CalendarClock, link: Link, clear: Check };

// Rows sized by their content, with the chip row's height as their floor (design-guidelines rule 3).
const ROW = "flex min-h-7 max-md:min-h-[26px] w-full items-center gap-2.5 rounded-md px-2 py-1 text-left text-[13px] text-text hover:bg-surface-hover active:bg-surface-hover disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent max-md:text-[15px]";

export function TaskSnoozeOptions({ task, onPick, today = localYmd(), pickingDate = false }: TaskSnoozeOptionsProps) {
  const [picking, setPicking] = useState(pickingDate);
  const [day, setDay] = useState(() => addDaysYmd(today, 3));
  const choices = snoozeChoices(task, today);
  const dayOk = isSnoozeDay(day, today);
  return (
    <div role="menu" aria-label="Snooze until" data-task-snooze-options="" className="flex flex-col gap-0.5">
      {choices.map((c) => {
        const Icon = ICONS[c.id];
        return (
          <button key={c.id} type="button" role="menuitem" data-snooze-choice={c.id} disabled={c.disabled} className={ROW}
            aria-expanded={c.id === "date" ? picking : undefined}
            onClick={() => (c.patch ? onPick(c.patch) : setPicking((v) => !v))}>
            <Icon aria-hidden className="size-4 shrink-0 text-text-3" />
            <span className={cn("min-w-0 flex-1 truncate", c.id === "clear" && "text-primary")}>{c.label}</span>
            {c.detail && <span className="shrink-0 text-[11.5px] text-text-3">{c.detail}</span>}
          </button>
        );
      })}
      {picking && (
        <form className="flex items-center gap-2 px-2 pb-1 pt-1" data-snooze-date-form=""
          onSubmit={(e) => { e.preventDefault(); if (dayOk) onPick(snoozeUntilPatch(day)); }}>
          <input type="date" aria-label="Snooze until this day" value={day} min={addDaysYmd(today, 1)} autoFocus
            onChange={(e) => setDay(e.target.value)}
            className={cn("min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-[13px] text-text outline-none focus:border-ring", TEXT_CONTROL_HEIGHT)} />
          <button type="submit" disabled={!dayOk} data-snooze-date-save=""
            className={cn("inline-flex shrink-0 items-center rounded-full bg-primary px-2.5 text-[11.5px] font-medium text-primary-foreground disabled:opacity-45 max-md:px-[5px]", TEXT_CONTROL_HEIGHT)}>
            Snooze
          </button>
        </form>
      )}
    </div>
  );
}
