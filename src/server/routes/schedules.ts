/** REST API for scheduled agents — CRUD + run-now + run history. Every schedule goes out as a view. */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import type { ScheduleView } from "../../types/scheduler.ts";
import { SESSION_ID_RE } from "../../shared/session-turn-ids.ts";
import { getSessionTitles } from "../../services/db.service.ts";
import { createSessionSchedule, patchSessionSchedule, sessionSchedulesOf } from "../../services/session-schedules/session-schedule-save.ts";
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
import { broadcastGlobalEvent } from "../ws/global.ts";
import { newScheduleFrom, scheduleChangesFrom } from "../../services/scheduler-edit.ts";
import { toScheduleView } from "../../services/scheduler-view.ts";
import { liveScript } from "../../services/schedule-script/instance-guard.ts";
import { removeRunDir } from "../../services/schedule-script/script-files.ts";
import { dropLogRing } from "../../services/schedule-script/script-log.ts";
import { editErrorResponse, scheduleScriptRoutes } from "./schedules-script.ts";

export const schedulesRoutes = new Hono();

/** The JSON object a write sent, or null for anything else (a malformed body is a 400, not a 500). */
async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  const body = await c.req.json<unknown>().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

/** Views with each session schedule's chat title, read in one query. */
function withChatTitles(views: ScheduleView[]): ScheduleView[] {
  const ids = [...new Set(views.flatMap((v) => (v.kind === "session" && v.target_session_id ? [v.target_session_id] : [])))];
  if (ids.length === 0) return views;
  const titles = getSessionTitles(ids);
  return views.map((v) => (v.kind === "session" ? { ...v, target_title: titles[v.target_session_id ?? ""] ?? null } : v));
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
 * Every schedule, or with `?session=<id>` the session schedules of that one chat under any id it
 * had (what a chat tab shows). A session schedule carries its chat's title.
 */
schedulesRoutes.get("/", (c) => {
  const session = c.req.query("session");
  if (session !== undefined && !SESSION_ID_RE.test(session)) return c.json(err("session must be a chat id"), 400);
  const enabledOnly = c.req.query("enabledOnly") === "true";
  const rows = session !== undefined ? sessionSchedulesOf(session).filter((s) => !enabledOnly || s.enabled) : getSchedules(enabledOnly);
  return c.json(ok(withChatTitles(rows.map(toScheduleView))));
});

schedulesRoutes.get("/:id{[0-9]+}", (c) => {
  const schedule = getSchedule(Number(c.req.param("id")));
  return schedule ? c.json(ok(withChatTitles([toScheduleView(schedule)])[0])) : c.json(err("Schedule not found"), 404);
});

schedulesRoutes.post("/", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json(err("The body must be a JSON object"), 400);
  try {
    // Project, provider and mode come from the chat; the fields only a prompt or script has are not read.
    if (body.kind === "session") {
      const created = createSessionSchedule(body);
      schedulerService.rearm();
      return c.json(ok(withChatTitles([toScheduleView(created)])[0]), 201);
    }
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
  const body = await readBody(c);
  if (!body) return c.json(err("The body must be a JSON object"), 400);
  if (current.kind === "session") {
    try {
      const saved = patchSessionSchedule(current, body);
      schedulerService.rearm();
      return c.json(ok(withChatTitles([toScheduleView(saved)])[0]));
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
