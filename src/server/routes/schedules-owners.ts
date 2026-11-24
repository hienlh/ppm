/**
 * Which chat owns a script or prompt schedule (`created_by_session_id`, the chat whose footer chip
 * lists it): `GET /owners` lists what the session trace would link (writes nothing — what
 * `ppm schedule owners --dry-run` prints), `POST /owners` links it, and `PATCH /:id/owner` sets or
 * clears one schedule's owner by hand. Mounted on `schedulesRoutes`, whose middleware tells every
 * open PPM after a write.
 */
import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { getDb, getSessionTitles } from "../../services/db.service.ts";
import { getSchedule } from "../../services/scheduler-db.service.ts";
import { applyScheduleOwners, planScheduleOwners, type ScheduleOwnerPlan } from "../../services/schedule-creator-backfill.ts";
import { changeScheduleOwner, ScheduleOwnerRefusal } from "../../services/schedule-owner.ts";
import { getTraceDbPath } from "../../services/session-trace/session-trace-db.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("scheduler");

export const scheduleOwnerRoutes = new Hono();

/** A plan row as the API answers it, with each chat's title for the person reading it. */
export interface ScheduleOwnerPlanView extends ScheduleOwnerPlan {
  ownerTitle: string | null;
  creatorTitle: string | null;
}

function planWithTitles(plans: ScheduleOwnerPlan[]): ScheduleOwnerPlanView[] {
  const titles = getSessionTitles([...new Set(plans.flatMap((p) => [p.sessionId, p.creator]))]);
  return plans.map((p) => ({ ...p, ownerTitle: titles[p.sessionId] ?? null, creatorTitle: titles[p.creator] ?? null }));
}

const warn = (m: string) => log.warn(m);

/** What linking would write now. Nothing is written. */
scheduleOwnerRoutes.get("/owners", (c) => {
  const plans = planScheduleOwners(getDb(), getTraceDbPath(), warn);
  return c.json(ok({ dryRun: true, plans: planWithTitles(plans) }));
});

/** Link every schedule the trace can name an owner for; only rows still without one change. */
scheduleOwnerRoutes.post("/owners", (c) => {
  const plans = planScheduleOwners(getDb(), getTraceDbPath(), warn);
  const filled = applyScheduleOwners(getDb(), plans, (m) => log.info(m), warn);
  return c.json(ok({ dryRun: false, linked: filled, plans: planWithTitles(plans) }));
});

/** `{ "sessionId": "<chat id>" | null }`: set or clear one script or prompt schedule's owner. */
scheduleOwnerRoutes.patch("/:id{[0-9]+}/owner", async (c) => {
  const schedule = getSchedule(Number(c.req.param("id")));
  if (!schedule) return c.json(err("Schedule not found"), 404);
  const body = await c.req.json<unknown>().catch(() => null) as { sessionId?: unknown } | null;
  if (!body || typeof body !== "object" || !("sessionId" in body) || (body.sessionId !== null && typeof body.sessionId !== "string")) {
    return c.json(err("The body must be { \"sessionId\": <chat id> | null }"), 400);
  }
  try {
    const owner = changeScheduleOwner(schedule, body.sessionId as string | null);
    log.info(`schedule #${schedule.id} "${schedule.name}" owner set by hand → ${owner ?? "none"}`);
    return c.json(ok({ id: schedule.id, created_by_session_id: owner }));
  } catch (e) {
    if (e instanceof ScheduleOwnerRefusal) return c.json(err(e.message), e.status);
    throw e;
  }
});
