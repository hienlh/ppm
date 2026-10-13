/**
 * What POST and PATCH /api/schedules save, checked by the rules templates follow
 * (`schedule-definition.ts`), so the routes and an import accept the same schedules.
 * Input values and secrets are patches: a key sent sets its value, null clears it, a key not
 * sent keeps what is saved. A value is only rewritten when it changes, because a new ciphertext
 * or a reordered JSON restarts an always-on process that had nothing to restart for.
 */
import { DEFAULT_TIMEOUT_MS, definitionProblems, inputValueFits, isPlainObject, SCHEDULE_LIMITS } from "../shared/schedule-definition.ts";
import { inputValueProblems, missingRequiredInputs, normalizeInputs, type InputValuePatch } from "../shared/schedule-inputs.ts";
import type { NewSchedule, Schedule, ScheduleInputDecl, ScheduleInputValue, ScheduleKind, ScheduleMode } from "../types/scheduler.ts";
import { encryptSecrets, readSecrets } from "./schedule-script/schedule-secrets.ts";
import { nextFireAt } from "./scheduler-timing.ts";

/** A body the route refuses: 400 when it is malformed, 409 when it would turn on a script that cannot run. */
export class ScheduleEditError extends Error {
  constructor(readonly problems: string[], readonly status: 400 | 409 = 400) {
    super(problems.join("\n"));
  }
}

type Body = Record<string, unknown>;
type Values = Record<string, ScheduleInputValue>;

/** Fields whose change is a change of what runs: only then is the whole definition checked again. */
const DEFINITION_FIELDS = ["kind", "mode", "cron_expr", "prompt", "script", "inputs", "timeout_ms", "max_turns", "permission_mode"];

export function newScheduleFrom(body: Body, providerId: string): NewSchedule {
  const kind = (body.kind ?? "prompt") as ScheduleKind;
  const mode = (body.mode ?? "tick") as ScheduleMode;
  const problems = [...nameProblems(body, true)];
  if (typeof body.project_path !== "string" || !body.project_path) problems.push("project_path is required");
  const def = {
    kind, mode,
    cron_expr: (body.cron_expr ?? (mode === "always-on" ? "" : undefined)) as string,
    prompt: (body.prompt ?? "") as string,
    script: (body.script ?? null) as string | null,
    inputs: body.inputs ?? [],
    timeout_ms: body.timeout_ms,
    max_turns: body.max_turns ?? undefined,
    permission_mode: body.permission_mode,
  };
  problems.push(...definitionProblems(templateSpelling(def)));
  if (problems.length) throw new ScheduleEditError(problems);

  const decls = normalizeInputs(def.inputs as ScheduleInputDecl[]);
  const values = inputs(decls, {}, {}, body);
  const enabled = body.enabled !== false;
  if (enabled && kind === "script") requireInputs(decls, values.values, values.secrets);
  return {
    name: (body.name as string).trim(),
    description: (body.description as string | undefined) ?? "",
    kind, mode,
    cron_expr: def.cron_expr,
    provider_id: providerId,
    project_path: body.project_path as string,
    prompt: kind === "prompt" ? def.prompt : "",
    script: kind === "script" ? def.script : null,
    permission_mode: def.permission_mode as string | undefined,
    max_turns: (def.max_turns as number | undefined) ?? null,
    timeout_ms: (def.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS[kind],
    enabled,
    next_fire_at: mode === "tick" ? nextFireAt(def.cron_expr) : null,
    inputs_json: JSON.stringify(decls),
    input_values_json: JSON.stringify(values.values),
    secrets_enc: encryptSecrets(values.secrets),
  };
}

export function scheduleChangesFrom(current: Schedule, body: Body): Partial<Schedule> {
  const problems = nameProblems(body, false);
  if (body.kind !== undefined && body.kind !== current.kind) problems.push("A schedule's kind cannot change; create a new schedule instead");
  if (body.project_path !== undefined && (typeof body.project_path !== "string" || !body.project_path)) problems.push("project_path is required");
  const mode = (body.mode ?? current.mode) as ScheduleMode;
  const def = {
    kind: current.kind, mode,
    cron_expr: (body.cron_expr !== undefined ? body.cron_expr : mode === "always-on" ? "" : current.cron_expr) as string,
    prompt: (body.prompt ?? current.prompt) as string,
    script: (body.script !== undefined ? body.script : current.script) as string | null,
    inputs: body.inputs ?? JSON.parse(current.inputs_json),
    // An always-on schedule keeps the stored value unused; one sent is refused by the rules.
    timeout_ms: body.timeout_ms !== undefined ? body.timeout_ms : mode === "tick" ? current.timeout_ms : undefined,
    max_turns: (body.max_turns !== undefined ? body.max_turns : current.max_turns) ?? undefined,
    permission_mode: body.permission_mode ?? current.permission_mode,
  };
  if (DEFINITION_FIELDS.some((f) => body[f] !== undefined)) problems.push(...definitionProblems(templateSpelling(def)));
  if (problems.length) throw new ScheduleEditError(problems);

  const changes: Partial<Schedule> = {};
  for (const key of ["name", "description", "project_path"] as const) {
    if (body[key] !== undefined) changes[key] = key === "name" ? (body.name as string).trim() : (body[key] as string);
  }
  if (DEFINITION_FIELDS.some((f) => body[f] !== undefined)) {
    Object.assign(changes, {
      mode, cron_expr: def.cron_expr, prompt: current.kind === "prompt" ? def.prompt : "",
      script: current.kind === "script" ? def.script : null, permission_mode: def.permission_mode as string,
      max_turns: (def.max_turns as number | undefined) ?? null, timeout_ms: (def.timeout_ms as number | undefined) ?? current.timeout_ms,
    });
  }
  const enabling = !!body.enabled && !current.enabled;
  if (body.enabled !== undefined) changes.enabled = body.enabled ? 1 : 0;
  if (mode === "always-on") changes.next_fire_at = null;
  else if (body.cron_expr !== undefined || body.mode !== undefined || enabling) changes.next_fire_at = nextFireAt(def.cron_expr);

  if (current.kind !== "script") return changes;
  const decls = normalizeInputs(def.inputs as ScheduleInputDecl[]);
  const savedValues = JSON.parse(current.input_values_json) as Values;
  let savedSecrets: Record<string, string> | null;
  try {
    savedSecrets = readSecrets(current);
  } catch {
    // Unreadable with this PPM's key: whatever is sent replaces them; nothing sent keeps them as they are.
    savedSecrets = null;
  }
  const merged = inputs(decls, savedValues, savedSecrets ?? {}, body);
  const inputsJson = JSON.stringify(decls);
  if (inputsJson !== current.inputs_json) changes.inputs_json = inputsJson;
  if (!sameRecord(merged.values, savedValues)) changes.input_values_json = JSON.stringify(merged.values);
  const secretsTouched = body.secrets !== undefined || body.inputs !== undefined;
  if (secretsTouched && (savedSecrets === null ? body.secrets !== undefined : !sameRecord(merged.secrets, savedSecrets))) {
    changes.secrets_enc = encryptSecrets(merged.secrets);
  }
  const touchesInputs = body.inputs !== undefined || body.inputValues !== undefined || body.secrets !== undefined;
  if ((changes.enabled ?? current.enabled) && (enabling || touchesInputs)) {
    const secretsNow = savedSecrets === null && changes.secrets_enc === undefined ? {} : merged.secrets;
    requireInputs(decls, merged.values, secretsNow);
  }
  return changes;
}

function nameProblems(body: Body, required: boolean): string[] {
  const problems: string[] = [];
  const { name, description } = body;
  if ((required || name !== undefined) && (typeof name !== "string" || !name.trim() || name.length > SCHEDULE_LIMITS.name)) {
    problems.push(`name must be 1-${SCHEDULE_LIMITS.name} characters`);
  }
  if (description !== undefined && (typeof description !== "string" || description.length > SCHEDULE_LIMITS.description)) {
    problems.push(`description must be text of at most ${SCHEDULE_LIMITS.description} characters`);
  }
  return problems;
}

/** The routes' fields spelled as a template spells them, for `definitionProblems`. */
function templateSpelling(d: { kind: string; mode: string; cron_expr: string; prompt: string; script: string | null; inputs: unknown; timeout_ms: unknown; max_turns: unknown; permission_mode: unknown }) {
  return {
    kind: d.kind, mode: d.mode,
    cron: d.mode === "always-on" && d.cron_expr === "" ? undefined : d.cron_expr,
    prompt: d.prompt, script: d.script ?? undefined, inputs: d.inputs,
    timeoutMs: d.timeout_ms, maxTurns: d.max_turns, permissionMode: d.permission_mode,
  };
}

/** Saved values with the body's patches applied, keeping only what the declarations still take. */
function inputs(decls: ScheduleInputDecl[], values: Values, secrets: Record<string, string>, body: Body) {
  const valuePatch = body.inputValues ?? {};
  const secretPatch = body.secrets ?? {};
  if (!isPlainObject(valuePatch)) throw new ScheduleEditError(["inputValues must be an object"]);
  if (!isPlainObject(secretPatch)) throw new ScheduleEditError(["secrets must be an object"]);
  const problems = inputValueProblems(decls, valuePatch as InputValuePatch, secretPatch as InputValuePatch);
  if (problems.length) throw new ScheduleEditError(problems);
  const out = { values: {} as Values, secrets: {} as Record<string, string> };
  for (const d of decls) {
    const patch = d.type === "secret" ? secretPatch : valuePatch;
    const value = d.key in patch ? patch[d.key] : d.type === "secret" ? secrets[d.key] : values[d.key];
    if (value === null || value === undefined || !inputValueFits(d, value)) continue;
    if (d.type === "secret") out.secrets[d.key] = value as string;
    else out.values[d.key] = value;
  }
  return out;
}

function requireInputs(decls: ScheduleInputDecl[], values: Values, secrets: Record<string, string>): void {
  const missing = missingRequiredInputs(decls, values, Object.keys(secrets));
  if (missing.length) throw new ScheduleEditError([`Fill in ${missing.join(", ")} before turning it on`], 409);
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && a[k] === b[k]);
}
