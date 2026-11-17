/**
 * `/api/tasks/:id/reminders`: the task page's "Remind…". A reminder is a session schedule the task
 * owns (`task-reminders.service.ts`), so reading, changing and deleting one go through
 * `/api/schedules` like any schedule (`?task=<id>` lists a task's); only creating needs the task.
 */
import { Hono } from "hono";
import { err, ok } from "../../types/api.ts";
import { createTaskReminder } from "../../services/task-reminders/task-reminders.service.ts";
import { toScheduleOverviews } from "../../services/schedules-overview.ts";
import { announceSchedulesChanged } from "../../services/session-schedules/session-schedules-changed.ts";
import { taskOr404 } from "./ppm-tasks-route-helpers.ts";
import { editErrorResponse } from "./schedules-script.ts";

export const taskRemindersRoutes = new Hono();

/** `{ at: "2026-11-17T18:30", timezone: "Europe/London", note? }` → the reminder, as an overview. */
taskRemindersRoutes.post("/:id/reminders", async (c) => {
  const task = taskOr404(c, c.req.param("id"));
  if (task instanceof Response) return task;
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json(err("The body must be a JSON object"), 400);
  try {
    const b = body as Record<string, unknown>;
    const created = createTaskReminder(task.id, { at: b.at, timezone: b.timezone, note: b.note });
    announceSchedulesChanged();
    return c.json(ok(toScheduleOverviews([created])[0]), 201);
  } catch (e) {
    return editErrorResponse(c, e);
  }
});
