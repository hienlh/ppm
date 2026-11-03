/**
 * A script schedule's state and live log, and any schedule as a shareable template.
 * An import is refused without `trust: true` — the person importing has read the code and
 * trusts it to run as them on this machine — and is always created turned off.
 */
import { homedir } from "node:os";
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { parseScheduleTemplate, scheduleTemplateFileName, templateFromSchedule } from "../../shared/schedule-template.ts";
import { getSchedule, insertSchedule } from "../../services/scheduler-db.service.ts";
import { alwaysOnSupervisor, schedulerService } from "../../services/scheduler.service.ts";
import { configService } from "../../services/config.service.ts";
import { getPpmDir } from "../../services/ppm-dir.ts";
import { projectService } from "../../services/project.service.ts";
import { newScheduleFrom, ScheduleEditError } from "../../services/scheduler-edit.ts";
import { scheduleStatus, toScheduleView } from "../../services/scheduler-view.ts";
import { clearState, saveState } from "../../services/schedule-script/ctx-state.ts";
import { liveScript } from "../../services/schedule-script/instance-guard.ts";
import { readSecrets } from "../../services/schedule-script/schedule-secrets.ts";
import { logRing } from "../../services/schedule-script/script-log.ts";
import { SECRET_MASK, secretMasker } from "../../services/schedule-script/secret-mask.ts";

export const scheduleScriptRoutes = new Hono();

/** A refused body: every problem in `problems`, all of them in the message too. */
export function editErrorResponse(c: Context, e: unknown) {
  if (e instanceof ScheduleEditError) return c.json({ ...err(e.message), problems: e.problems }, e.status);
  return c.json(err((e as Error).message), 400);
}

/** Lines the schedule printed after `after`; `last` starts again from 0 when the server does. */
scheduleScriptRoutes.get("/:id{[0-9]+}/logs", (c) => {
  const schedule = getSchedule(Number(c.req.param("id")));
  if (!schedule) return c.json(err("Schedule not found"), 404);
  const ring = logRing(schedule.id);
  return c.json(ok({ status: scheduleStatus(schedule), lines: ring.since(Number(c.req.query("after")) || 0), last: ring.last }));
});

scheduleScriptRoutes.get("/:id{[0-9]+}/state", (c) => {
  const schedule = getSchedule(Number(c.req.param("id")));
  if (!schedule) return c.json(err("Schedule not found"), 404);
  if (schedule.kind !== "script") return c.json(err("Only a script schedule has a state"), 400);
  return c.json(ok({ state: maskedState(schedule) }));
});

scheduleScriptRoutes.put("/:id{[0-9]+}/state", async (c) => {
  const id = Number(c.req.param("id"));
  const schedule = getSchedule(id);
  if (!schedule) return c.json(err("Schedule not found"), 404);
  if (schedule.kind !== "script") return c.json(err("Only a script schedule has a state"), 400);
  // A process running now would write its own state over this one when it saves.
  if (schedule.enabled) return c.json(err("Turn the schedule off before replacing its state"), 409);
  if (liveScript(id) || alwaysOnSupervisor.status(id)) return c.json(err("Its process has not stopped yet; try again in a moment"), 409);
  const body = await c.req.json<Record<string, unknown>>();
  if (!("state" in body)) return c.json(err("state is required (null forgets it)"), 400);
  if (body.state === null) clearState(id);
  else {
    const json = JSON.stringify(body.state);
    if (json?.includes(SECRET_MASK)) {
      return c.json(err(`This state has masked secrets (${SECRET_MASK}) in it; put the real values back or leave them out`), 400);
    }
    try {
      saveState(id, json);
    } catch (e) {
      return c.json(err((e as Error).message), 400);
    }
  }
  return c.json(ok({ state: maskedState(getSchedule(id)!) }));
});

scheduleScriptRoutes.get("/:id{[0-9]+}/export", (c) => {
  const schedule = getSchedule(Number(c.req.param("id")));
  if (!schedule) return c.json(err("Schedule not found"), 404);
  const view = toScheduleView(schedule);
  const { template, warnings } = templateFromSchedule(
    {
      name: view.name, description: view.description, kind: view.kind, mode: view.mode, cron_expr: view.cron_expr,
      prompt: view.prompt, script: view.script, inputs: view.inputs, inputValues: view.inputValues,
      timeout_ms: view.timeout_ms, max_turns: view.max_turns, permission_mode: view.permission_mode,
    },
    [schedule.project_path, getPpmDir(), homedir()],
  );
  return c.json(ok({ template, fileName: scheduleTemplateFileName(schedule.name), warnings }));
});

scheduleScriptRoutes.post("/import", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (body.trust !== true) {
    return c.json(err("Read the code first: an import needs trust: true, your word that you trust it to run on this machine"), 400);
  }
  const parsed = parseScheduleTemplate(body.template);
  if (!parsed.ok) return c.json({ ...err(parsed.errors.join("\n")), problems: parsed.errors }, 400);
  const project = typeof body.projectName === "string" ? findProject(body.projectName) : null;
  if (!project) return c.json(err("projectName must be a project in PPM"), 400);
  const t = parsed.template;
  try {
    const id = insertSchedule(newScheduleFrom({
      name: t.name, description: t.description, kind: t.kind, mode: t.mode, cron_expr: t.cron, prompt: t.prompt,
      script: t.script, inputs: t.inputs, timeout_ms: t.timeoutMs, max_turns: t.maxTurns, permission_mode: t.permissionMode,
      project_path: project.path, inputValues: body.inputValues, secrets: body.secrets,
      // Turning it on is a separate, deliberate step.
      enabled: false,
    }, configService.get("ai").default_provider));
    schedulerService.rearm();
    return c.json(ok(toScheduleView(getSchedule(id)!)), 201);
  } catch (e) {
    return editErrorResponse(c, e);
  }
});

/** The state as indented JSON with every secret value masked; null when it has none. */
function maskedState(schedule: Schedule): string | null {
  if (schedule.state_json === null) return null;
  let text: string;
  try {
    text = JSON.stringify(JSON.parse(schedule.state_json), null, 2);
  } catch {
    text = schedule.state_json;
  }
  let secrets: string[] = [];
  try {
    secrets = Object.values(readSecrets(schedule));
  } catch { /* unreadable with this key: nothing it could be masked against */ }
  return secretMasker(secrets)(text);
}

function findProject(name: string): { name: string; path: string } | null {
  try {
    return projectService.resolve(name);
  } catch {
    return null;
  }
}
