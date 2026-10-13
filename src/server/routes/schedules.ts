/** REST API for scheduled agents — CRUD + run-now + run history. Every schedule goes out as a view. */
import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  getSchedules,
  getSchedule,
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  listScheduleRuns,
} from "../../services/scheduler-db.service.ts";
import { ScheduleBusyError } from "../../services/scheduler-core.ts";
import { alwaysOnSupervisor, schedulerService } from "../../services/scheduler.service.ts";
import { configService } from "../../services/config.service.ts";
import { newScheduleFrom, scheduleChangesFrom } from "../../services/scheduler-edit.ts";
import { toScheduleView } from "../../services/scheduler-view.ts";
import { liveScript } from "../../services/schedule-script/instance-guard.ts";
import { removeRunDir } from "../../services/schedule-script/script-files.ts";
import { dropLogRing } from "../../services/schedule-script/script-log.ts";
import { editErrorResponse, scheduleScriptRoutes } from "./schedules-script.ts";

export const schedulesRoutes = new Hono();

schedulesRoutes.get("/", (c) => {
  const enabledOnly = c.req.query("enabledOnly") === "true";
  return c.json(ok(getSchedules(enabledOnly).map(toScheduleView)));
});

schedulesRoutes.get("/:id{[0-9]+}", (c) => {
  const schedule = getSchedule(Number(c.req.param("id")));
  return schedule ? c.json(ok(toScheduleView(schedule))) : c.json(err("Schedule not found"), 404);
});

schedulesRoutes.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  try {
    // Snapshot the default provider so resume keeps working if default changes later
    const id = insertSchedule(newScheduleFrom(body, configService.get("ai").default_provider));
    schedulerService.rearm();
    return c.json(ok(toScheduleView(getSchedule(id)!)), 201);
  } catch (e) {
    return editErrorResponse(c, e);
  }
});

schedulesRoutes.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const current = getSchedule(id);
  if (!current) return c.json(err("Schedule not found"), 404);
  const body = await c.req.json<Record<string, unknown>>();
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
  return c.json(ok(toScheduleView(getSchedule(id)!)));
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
    return c.json(err((e as Error).message), e instanceof ScheduleBusyError ? 409 : 400);
  }
});

schedulesRoutes.get("/:id{[0-9]+}/runs", (c) => {
  const id = Number(c.req.param("id"));
  if (!getSchedule(id)) return c.json(err("Schedule not found"), 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 200);
  return c.json(ok(listScheduleRuns(id, limit)));
});

schedulesRoutes.route("/", scheduleScriptRoutes);
