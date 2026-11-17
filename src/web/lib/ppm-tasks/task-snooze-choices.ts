/**
 * The "Snooze until…" choices as pure data: Tomorrow, 1 week, Pick a date, Until a link changes,
 * and Unsnooze, each with the patch it writes. The picker on a desktop (popover), on a phone
 * (bottom sheet) and the row menu all draw these, so the three never disagree.
 */
import {
  hasSnooze, hasWatchableLink, shortDay, snoozeOneWeek, snoozeText, snoozeTomorrow, type TaskPatch,
} from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";

export type SnoozeChoiceId = "tomorrow" | "week" | "date" | "link" | "clear";

export interface SnoozeChoice {
  id: SnoozeChoiceId;
  label: string;
  /** "Wed 18 Nov", or why the choice is off. */
  detail: string | null;
  disabled: boolean;
  /** What it writes; null for Pick a date, which asks for the day first. */
  patch: Pick<TaskPatch, "snoozedUntil" | "snoozeUntilChange"> | null;
}

/** Bring the task back now. */
export const UNSNOOZE_PATCH = { snoozedUntil: null, snoozeUntilChange: false } as const;

/** A snooze until `day`; a link watch the task had stops, as a picked day replaces the snooze. */
export const snoozeUntilPatch = (day: string) => ({ snoozedUntil: day, snoozeUntilChange: false });

type SnoozeTask = Pick<TaskDto, "snoozedUntil" | "snoozeUntilChange" | "links" | "baseGroup">;

/** The choices for this task on `today` (the user's `YYYY-MM-DD`). */
export function snoozeChoices(task: SnoozeTask, today: string): SnoozeChoice[] {
  const tomorrow = snoozeTomorrow(today);
  const week = snoozeOneWeek(today);
  const watchable = hasWatchableLink(task.links);
  const choices: SnoozeChoice[] = [
    { id: "tomorrow", label: "Tomorrow", detail: shortDay(tomorrow, today), disabled: false, patch: snoozeUntilPatch(tomorrow) },
    { id: "week", label: "1 week", detail: shortDay(week, today), disabled: false, patch: snoozeUntilPatch(week) },
    { id: "date", label: "Pick a date…", detail: null, disabled: false, patch: null },
    {
      id: "link", label: "Until a link changes", disabled: !watchable,
      detail: watchable ? "Jira status or PR update" : "Needs a Jira or PR link",
      patch: { snoozedUntil: null, snoozeUntilChange: true },
    },
  ];
  if (hasSnooze(task)) choices.push({ id: "clear", label: "Unsnooze", detail: "Back in the list now", disabled: false, patch: UNSNOOZE_PATCH });
  return choices;
}

/** Whether a picked day can be a snooze day: a whole date after today. */
export function isSnoozeDay(day: string, today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day > today;
}

/** "Snoozed until Thu 20 Nov" for a toast or a button; null when not snoozed. */
export function snoozedLabel(task: Pick<TaskDto, "snoozedUntil" | "snoozeUntilChange">, today?: string): string | null {
  const text = snoozeText(task, today);
  return text ? `Snoozed ${text}` : null;
}
