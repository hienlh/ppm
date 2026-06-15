/** REST API for scheduled agents — CRUD + run-now + run history. */
import { Hono } from "hono";
import { Cron } from "croner";
import { ok, err } from "../../types/api.ts";
import {
  getSchedules,
  getSchedule,
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  listScheduleRuns,
} from "../../services/scheduler-db.service.ts";
import { nextFireAt } from "../../services/scheduler-core.ts";
import { schedulerService } from "../../services/scheduler.service.ts";
import { configService } from "../../services/config.service.ts";

export const schedulesRoutes = new Hono();

function validateCron(expr: string): string | null {
  try { new Cron(expr); return null; } catch (e) { return (e as Error).message; }
}

/** Validate optional numeric budget fields. Returns error message or null. */
function validateBudgets(body: Record<string, unknown>): string | null {
  if (body.max_turns != null) {
    const n = Number(body.max_turns);
    if (!Number.isInteger(n) || n < 1) return "max_turns must be a positive integer";
  }
  if (body.timeout_ms != null) {
    const n = Number(body.timeout_ms);
    if (!Number.isInteger(n) || n < 10_000) return "timeout_ms must be an integer >= 10000";
  }
  return null;
}

schedulesRoutes.get("/", (c) => {
  const enabledOnly = c.req.query("enabledOnly") === "true";
  return c.json(ok(getSchedules(enabledOnly)));
});

schedulesRoutes.get("/:id{[0-9]+}", (c) => {
  const schedule = getSchedule(Number(c.req.param("id")));
  return schedule ? c.json(ok(schedule)) : c.json(err("Schedule not found"), 404);
});

schedulesRoutes.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { name, cron_expr, project_path, prompt } = body as Record<string, string>;
  if (!name || !cron_expr || !project_path || !prompt) {
    return c.json(err("name, cron_expr, project_path, prompt are required"), 400);
  }
  const cronError = validateCron(cron_expr);
  if (cronError) return c.json(err(`Invalid cron expression: ${cronError}`), 400);
  const budgetError = validateBudgets(body);
  if (budgetError) return c.json(err(budgetError), 400);

  const id = insertSchedule({
    name,
    cron_expr,
    // Snapshot the default provider so resume keeps working if default changes later
    provider_id: configService.get("ai").default_provider,
    project_path,
    prompt,
    permission_mode: body.permission_mode as string | undefined,
    max_turns: body.max_turns != null ? Number(body.max_turns) : null,
    timeout_ms: body.timeout_ms != null ? Number(body.timeout_ms) : undefined,
    enabled: body.enabled !== false,
    next_fire_at: nextFireAt(cron_expr),
  });
  return c.json(ok(getSchedule(id)), 201);
});

schedulesRoutes.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  if (!getSchedule(id)) return c.json(err("Schedule not found"), 404);
  const body = await c.req.json<Record<string, unknown>>();
  const budgetError = validateBudgets(body);
  if (budgetError) return c.json(err(budgetError), 400);

  const fields: Record<string, string | number | null> = {};
  for (const key of ["name", "cron_expr", "project_path", "prompt", "permission_mode", "max_turns", "timeout_ms"] as const) {
    if (body[key] !== undefined) fields[key] = body[key] as string | number | null;
  }
  if (body.enabled !== undefined) fields.enabled = body.enabled ? 1 : 0;
  if (typeof fields.cron_expr === "string") {
    const cronError = validateCron(fields.cron_expr);
    if (cronError) return c.json(err(`Invalid cron expression: ${cronError}`), 400);
    fields.next_fire_at = nextFireAt(fields.cron_expr);
  } else if (fields.enabled === 1) {
    // Re-enabling: recompute from now so it doesn't fire immediately off a stale timestamp
    const current = getSchedule(id)!;
    fields.next_fire_at = nextFireAt(current.cron_expr);
  }
  updateSchedule(id, fields);
  return c.json(ok(getSchedule(id)));
});

schedulesRoutes.delete("/:id{[0-9]+}", (c) => {
  const id = Number(c.req.param("id"));
  if (!getSchedule(id)) return c.json(err("Schedule not found"), 404);
  deleteSchedule(id);
  return c.json(ok(true));
});

schedulesRoutes.post("/:id{[0-9]+}/run-now", (c) => {
  try {
    const result = schedulerService.runJobNow(Number(c.req.param("id")));
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 404);
  }
});

schedulesRoutes.get("/:id{[0-9]+}/runs", (c) => {
  const id = Number(c.req.param("id"));
  if (!getSchedule(id)) return c.json(err("Schedule not found"), 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 200);
  return c.json(ok(listScheduleRuns(id, limit)));
});
