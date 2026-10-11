import { allowRoute, type RouteRule } from "./assistant-route-rules.ts";
import type { FamilyHandlers } from "./assistant-tool-family.ts";
import {
  SCHEDULE_DELETE_TOOL, SCHEDULE_GET_TOOL, SCHEDULE_RUN_NOW_TOOL, SCHEDULE_SAVE_TOOL, SCHEDULES_LIST_TOOL,
} from "../../shared/assistant-schedule-tool-names.ts";
import { scheduleGet, schedulesList } from "./assistant-schedule-read-tools.ts";
import { scheduleDelete, scheduleRunNow, scheduleSave } from "./assistant-schedule-write-tools.ts";

/**
 * The schedule tools' handlers and the only routes they may call. `SCHEDULE_ROUTES` is this
 * family's whole reach into PPM's routes (see `assistant-route-call.ts`): the `/api/schedules`
 * routes the Settings → Schedules section uses, and nothing else — a schedule tool cannot reach a
 * project, git or tunnel route even by building the path itself.
 */
export const SCHEDULE_ROUTES: readonly RouteRule[] = [
  allowRoute("GET", "/api/schedules"),
  allowRoute("GET", "/api/schedules/:id"),
  allowRoute("GET", "/api/schedules/:id/runs", ["limit"]),
  allowRoute("POST", "/api/schedules"),
  allowRoute("PATCH", "/api/schedules/:id"),
  allowRoute("DELETE", "/api/schedules/:id"),
  allowRoute("POST", "/api/schedules/:id/run-now"),
];

export const SCHEDULE_TOOL_HANDLERS: FamilyHandlers = {
  [SCHEDULES_LIST_TOOL]: (ctx, args) => schedulesList(ctx, args),
  [SCHEDULE_GET_TOOL]: (ctx, args) => scheduleGet(ctx, args),
  [SCHEDULE_SAVE_TOOL]: (ctx, args) => scheduleSave(ctx, args),
  [SCHEDULE_DELETE_TOOL]: (ctx, args) => scheduleDelete(ctx, args),
  [SCHEDULE_RUN_NOW_TOOL]: (ctx, args) => scheduleRunNow(ctx, args),
};
