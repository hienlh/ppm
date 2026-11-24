/** REST API for scheduled agents — CRUD + run-now + run history. Every schedule goes out as an overview (a view plus its newest run, project, mode and task). */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { SESSION_ID_RE } from "../../shared/session-turn-ids.ts";

import { chatSchedulesOf, createSessionSchedule, creatorOf, patchSessionSchedule } from "../../services/session-schedules/session-schedule-save.ts";
import {
  getSchedules,
  getSchedule,
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  listScheduleRuns,
  listSchedulesForTask,
  lastRunsFor,
  setAttentionDismissed,
} from "../../services/scheduler-db.service.ts";
import { ScheduleBusyError } from "../../services/scheduler-core.ts";
import { SessionScheduleRetryWaitError } from "../../services/session-schedules/session-schedule-due.ts";
import { alwaysOnSupervisor, schedulerService } from "../../services/scheduler.service.ts";
import { configService } from "../../services/config.service.ts";
import { broadcastGlobalEvent } from "../ws/global.ts";
import { newScheduleFrom, scheduleChangesFrom } from "../../services/scheduler-edit.ts";
import { toScheduleOverviews as overviewsOf } from "../../services/schedules-overview.ts";
import { chatTargetMode } from "../ws/chat.ts";
import { scheduleProblem } from "../../shared/schedule-attention.ts";
import { liveScript } from "../../services/schedule-script/instance-guard.ts";
import { removeRunDir } from "../../services/schedule-script/script-files.ts";
import { dropLogRing } from "../../services/schedule-script/script-log.ts";
import { editErrorResponse, scheduleScriptRoutes } from "./schedules-script.ts";
import { scheduleOwnerRoutes } from "./schedules-owners.ts";

export const schedulesRoutes = new Hono();

/** Overviews whose chat reminders name the mode their chat would really run a message in now. */
const toScheduleOverviews = (rows: Parameters<typeof overviewsOf>[0]) => overviewsOf(rows, (id, provider) => chatTargetMode(id, provider).mode);

/** A task id as the task store mints them (`crypto.randomUUID()`). */
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The JSON object a write sent, or null for anything else (a malformed body is a 400, not a 500). */
async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  const body = await c.req.json<unknown>().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

/**
 * Tells every open PPM that the schedules changed, after any write this router carried out —
 * whoever made it (the Settings form, the Assistant's tools, another device) — so an open
 * Settings → Schedules re-reads at once instead of on its next poll. Runs after the handler and
 * never touches its answer; registered first so it wraps every route below.
 */
schedulesRoutes.use("*", async (c, next) => {
  await next();
  if (c.req.method !== "GET" && c.res.status >= 200 && c.res.status < 300) {
    broadcastGlobalEvent({ type: "schedules:changed" });
  }
});

/**
 * Every schedule, or with `?session=<id>` what that one chat's footer chip lists under any id it
 * had (the session schedules aimed at it and every schedule its AI created), or with `?task=<id>` the reminders that task owns. Each comes as an
 * overview (`schedules-overview.ts`): the view plus its newest run, project, effective permission
 * mode and task, which is everything the Schedules window and the rail's count read.
 */
schedulesRoutes.get("/", (c) => {
  const session = c.req.query("session");
  if (session !== undefined && !SESSION_ID_RE.test(session)) return c.json(err("session must be a chat id"), 400);
  const task = c.req.query("task");
  if (task !== undefined && !TASK_ID_RE.test(task)) return c.json(err("task must be a task id"), 400);
  const enabledOnly = c.req.query("enabledOnly") === "true";
  const rows = session !== undefined ? chatSchedulesOf(session) : task !== undefined ? listSchedulesForTask(task) : getSchedules();
  return c.json(ok(toScheduleOverviews(rows.filter((s) => !enabledOnly || s.enabled))));
});

schedulesRoutes.get("/:id{[0-9]+}", (c) => {
  const schedule = getSchedule(Number(c.req.param("id")));
  return schedule ? c.json(ok(toScheduleOverviews([schedule])[0])) : c.json(err("Schedule not found"), 404);
});

/**
 * Dismiss the problem the red dot is for. The body names the problem's key as the window showed
 * it, so a dismiss sent after the problem changed (another run failed meanwhile) is refused rather
 * than silencing something the user never saw. `{ key: null }` brings the dot back.
 */
schedulesRoutes.post("/:id{[0-9]+}/dismiss", async (c) => {
  const id = Number(c.req.param("id"));
  const schedule = getSchedule(id);
  if (!schedule) return c.json(err("Schedule not found"), 404);
  const body = await readBody(c);
  if (!body || (body.key !== null && typeof body.key !== "string")) return c.json(err("key must be the problem's key or null"), 400);
  if (body.key !== null) {
    const problem = scheduleProblem({ ...schedule, last_run: lastRunsFor([id]).get(id) ?? null });
    if (!problem || problem.key !== body.key) return c.json(err("That problem is no longer the schedule's current one"), 409);
  }
  setAttentionDismissed(id, body.key as string | null);
  return c.json(ok(toScheduleOverviews([getSchedule(id)!])[0]));
});

schedulesRoutes.post("/", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json(err("The body must be a JSON object"), 400);
  try {
    // Project, provider and mode come from the chat; the fields only a prompt or script has are not read.
    if (body.kind === "session") {
      const created = createSessionSchedule(body);
      schedulerService.rearm();
      return c.json(ok(toScheduleOverviews([created])[0]), 201);
    }
    // Snapshot the default provider so resume keeps working if default changes later
    // `created_by_session_id` is set by the PPM Assistant's tools: it only lists the schedule in that chat's chip.
    const id = insertSchedule({ ...newScheduleFrom(body, configService.get("ai").default_provider), created_by_session_id: creatorOf(body) });
    schedulerService.rearm();
    return c.json(ok(toScheduleOverviews([getSchedule(id)!])[0]), 201);
  } catch (e) {
    return editErrorResponse(c, e);
  }
});

schedulesRoutes.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const current = getSchedule(id);
  if (!current) return c.json(err("Schedule not found"), 404);
  const body = await readBody(c);
  if (!body) return c.json(err("The body must be a JSON object"), 400);
  if (current.kind === "session") {
    try {
      const saved = patchSessionSchedule(current, body);
      schedulerService.rearm();
      return c.json(ok(toScheduleOverviews([saved])[0]));
    } catch (e) {
      return editErrorResponse(c, e);
    }
  }
  try {
    const changes = scheduleChangesFrom(current, body);
    // The always-on process would find the tick's still there and fail to start.
    if (changes.mode === "always-on" && current.mode === "tick" && liveScript(id)) {
      return c.json(err("This schedule is running now; change its mode when the run has ended"), 409);
    }
    updateSchedule(id, changes);
  } catch (e) {
    return editErrorResponse(c, e);
  }
  schedulerService.rearm();
  return c.json(ok(toScheduleOverviews([getSchedule(id)!])[0]));
});

schedulesRoutes.delete("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const schedule = getSchedule(id);
  if (!schedule) return c.json(err("Schedule not found"), 404);
  if (schedule.kind === "script") {
    // Off first, so nothing starts it again; then its process is gone before its row is.
    if (schedule.enabled) updateSchedule(id, { enabled: 0 });
    await alwaysOnSupervisor.stop(id);
    await liveScript(id)?.stop("it was deleted");
  }
  deleteSchedule(id);
  if (schedule.kind === "script") {
    removeRunDir(id);
    dropLogRing(id);
  }
  schedulerService.rearm();
  return c.json(ok(true));
});

schedulesRoutes.post("/:id{[0-9]+}/run-now", (c) => {
  const id = Number(c.req.param("id"));
  if (!getSchedule(id)) return c.json(err("Schedule not found"), 404);
  try {
    return c.json(ok(schedulerService.runJobNow(id)));
  } catch (e) {
    // A session schedule whose chat waits to retry is not queued again: the answer says when it goes.
    const conflict = e instanceof ScheduleBusyError || e instanceof SessionScheduleRetryWaitError;
    return c.json(err((e as Error).message), conflict ? 409 : 400);
  }
});

schedulesRoutes.get("/:id{[0-9]+}/runs", (c) => {
  const id = Number(c.req.param("id"));
  if (!getSchedule(id)) return c.json(err("Schedule not found"), 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 200);
  return c.json(ok(listScheduleRuns(id, limit)));
});

schedulesRoutes.route("/", scheduleOwnerRoutes);
schedulesRoutes.route("/", scheduleScriptRoutes);
