/**
 * A task's reminders: one-shot (or, from the AI, recurring) session schedules that the task owns
 * through `schedules.task_id`. The task page creates them here; the AI's `session_schedule_create`
 * links one with its `task` argument, checked by `task-reminder-link.ts`. Either way the schedule is
 * an ordinary session schedule — the scheduler, its delivery into the chat and the Schedules window
 * need nothing else — and closing or deleting the task deletes it (`task-reminder-cleanup.ts`).
 */
import { ScheduleEditError } from "../scheduler-edit.ts";
import { nextFireAt } from "../scheduler-timing.ts";
import { createSessionSchedule } from "../session-schedules/session-schedule-save.ts";
import { getTask } from "../ppm-tasks/ppm-tasks-read.ts";
import { managerSessionFor } from "../ppm-tasks/ppm-tasks-write.ts";
import { taskProjectName } from "./task-project-name.ts";
import { timezoneProblem } from "../../shared/session-schedule-input.ts";
import {
  localMomentText, localMomentToEpoch, parseLocalMoment, REMINDER_MAX_AHEAD_MS, REMINDER_NOTE_MAX, reminderCron, reminderName,
  reminderPrompt,
} from "../../shared/task-reminder.ts";
import type { Schedule } from "../../types/scheduler.ts";
import type { TaskView } from "../../shared/ppm-tasks.ts";

export interface TaskReminderInput {
  /** `2026-11-17T18:30`, as the clock in `timezone` reads it. */
  at: unknown;
  timezone: unknown;
  note?: unknown;
}

/** The task, open and not deleted, or why a reminder cannot be tied to it. */
function openTask(taskId: string): TaskView {
  const task = getTask(taskId);
  if (!task || task.deletedAt !== null) throw new ScheduleEditError(["No such task"]);
  if (task.baseGroup === "closed") throw new ScheduleEditError(["This task is closed: it needs no reminder"]);
  return task;
}

/**
 * Where a reminder is delivered: the project's manager chat, which follows every task, else the
 * chat working on the task. Null when the task has neither.
 */
export function reminderChatFor(task: Pick<TaskView, "projectKey" | "workingSessionId">): string | null {
  return managerSessionFor(task.projectKey) ?? task.workingSessionId ?? null;
}

/**
 * Create a reminder for `taskId` from the task page. The moment must be ahead and less than a year
 * away, read in its own zone; the schedule fires once and deletes itself, or goes with the task.
 */
export function createTaskReminder(taskId: string, input: TaskReminderInput, now: Date = new Date()): Schedule {
  const task = openTask(taskId);
  const problems: string[] = [];
  const zoneProblem = timezoneProblem(input.timezone);
  if (zoneProblem || typeof input.timezone !== "string" || !input.timezone) problems.push(zoneProblem ?? "timezone is required");
  const at = parseLocalMoment(input.at);
  if (!at) problems.push("at must be a date and time like 2026-11-17T18:30");
  const note = input.note === undefined || input.note === null ? "" : input.note;
  if (typeof note !== "string" || note.length > REMINDER_NOTE_MAX) problems.push(`note must be text of at most ${REMINDER_NOTE_MAX} characters`);
  if (problems.length || !at) throw new ScheduleEditError(problems);

  const zone = input.timezone as string;
  const cron = reminderCron(at);
  // The cron has no year: it fires at the next match, which is the asked moment only when that
  // moment is ahead and within the coming year.
  const asked = localMomentToEpoch(at, zone);
  if (asked <= now.getTime()) throw new ScheduleEditError(["That time has already passed"]);
  if (asked - now.getTime() > REMINDER_MAX_AHEAD_MS) throw new ScheduleEditError(["A reminder can be set at most a year ahead"]);
  const next = nextFireAt(cron, zone, now);
  if (!next || localMomentText(new Date(next), zone) !== localMomentText(new Date(asked), zone)) {
    throw new ScheduleEditError(["That time does not exist on the clock of that time zone"]);
  }

  const target = reminderChatFor(task);
  if (!target) throw new ScheduleEditError(["This project has no manager chat and nobody is working on the task, so there is no chat to remind"]);
  const project = taskProjectName(task.projectKey);
  const named = { number: task.number, project, title: task.title };
  return createSessionSchedule({
    target_session_id: target,
    cron_expr: cron,
    timezone: zone,
    recurring: false,
    name: reminderName(named),
    prompt: reminderPrompt(named, (note as string).trim() || null),
    task_id: task.id,
  }, { now });
}
