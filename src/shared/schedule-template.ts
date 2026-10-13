/**
 * A schedule as one shareable file, `<name>.ppm-schedule.json`.
 *
 * What a template never carries: a secret's value, ids, the chat session, the script's state,
 * run history, the project or provider it ran on, or a path on the machine it came from. A
 * secret input is declared with no default, and a file that gives one a default is refused, so
 * nobody shares a token by exporting a schedule. Parsing is strict: an unknown field or format
 * version refuses the whole file rather than dropping what it does not understand.
 */
import type { ScheduleInputDecl, ScheduleInputValue, ScheduleKind, ScheduleMode } from "../types/scheduler.ts";
import { definitionProblems, isPlainObject, SCHEDULE_LIMITS, type ScheduleDefinition } from "./schedule-definition.ts";

export const SCHEDULE_TEMPLATE_VERSION = 1;
export const SCHEDULE_TEMPLATE_SUFFIX = ".ppm-schedule.json";

export interface ScheduleTemplate extends ScheduleDefinition {
  ppmScheduleTemplate: typeof SCHEDULE_TEMPLATE_VERSION;
  name: string;
  description?: string;
}

export type TemplateParse = { ok: true; template: ScheduleTemplate } | { ok: false; errors: string[] };

/** Field order of a written template; also the only fields a template may have. */
const FIELDS = [
  "ppmScheduleTemplate", "name", "description", "kind", "mode", "cron", "prompt", "script",
  "inputs", "timeoutMs", "maxTurns", "permissionMode",
] as const;

const INPUT_ORDER = ["key", "label", "type", "required", "default", "description"] as const;

/** A path that only means something on the machine it was written on. */
const ABSOLUTE_PATH = /^(?:\/|~(?:[/\\]|$)|[A-Za-z]:[\\/]|\\\\)/;

export function parseScheduleTemplate(input: unknown): TemplateParse {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      // Not the parser's message: it quotes the text it stopped at, and a file picked by
      // mistake can be a token (`Unexpected identifier "ghp_…"`).
      return { ok: false, errors: ["This file is not JSON"] };
    }
  }
  if (!isPlainObject(data) || !("ppmScheduleTemplate" in data)) {
    return { ok: false, errors: ["This is not a PPM schedule template (it has no ppmScheduleTemplate field)"] };
  }
  const version = data.ppmScheduleTemplate;
  if (version !== SCHEDULE_TEMPLATE_VERSION) {
    return {
      ok: false,
      errors: [typeof version === "number" && version > SCHEDULE_TEMPLATE_VERSION
        ? `This template was made by a newer PPM (format ${version}); update PPM to import it`
        : `Unknown template format: ${JSON.stringify(version)}`],
    };
  }
  const errors: string[] = [];
  for (const field of Object.keys(data)) {
    if (!(FIELDS as readonly string[]).includes(field)) errors.push(`Unknown field "${field}"`);
  }
  const { name, description } = data;
  if (typeof name !== "string" || !name.trim() || name.length > SCHEDULE_LIMITS.name) {
    errors.push(`name must be 1-${SCHEDULE_LIMITS.name} characters`);
  }
  if (description !== undefined && (typeof description !== "string" || description.length > SCHEDULE_LIMITS.description)) {
    errors.push(`description must be text of at most ${SCHEDULE_LIMITS.description} characters`);
  }
  errors.push(...definitionProblems(data));
  if (errors.length) return { ok: false, errors };
  return { ok: true, template: ordered(data) as unknown as ScheduleTemplate };
}

/** The schedule fields an export reads, as the server holds them. */
export interface TemplateSource {
  name: string;
  description: string;
  kind: ScheduleKind;
  mode: ScheduleMode;
  cron_expr: string;
  prompt: string;
  script: string | null;
  inputs: ScheduleInputDecl[];
  inputValues: Record<string, ScheduleInputValue>;
  timeout_ms: number;
  max_turns: number | null;
  permission_mode: string;
}

/**
 * A template of `s`. A non-secret input's current value becomes its default, unless it looks
 * like an absolute path (which is warned about). `machinePaths` (the home directory, the project folder) are looked for
 * in the script or prompt: each line that names one comes back as a warning, not a refusal —
 * the code is the author's to fix.
 */
export function templateFromSchedule(s: TemplateSource, machinePaths: string[] = []): { template: ScheduleTemplate; warnings: string[] } {
  const warnings: string[] = [];
  const inputs = s.inputs.map((decl) => {
    const { default: declared, ...rest } = decl;
    const current = s.inputValues[decl.key];
    if (decl.type === "secret") return rest;
    const isPath = typeof current === "string" && ABSOLUTE_PATH.test(current);
    if (isPath) warnings.push(`The value of "${decl.key}" is a path on this machine, so it was left out`);
    const keepDeclared = current === undefined || isPath;
    const value = keepDeclared ? declared : current;
    return value === undefined ? rest : { ...rest, default: value };
  });
  const raw: Record<string, unknown> = {
    ppmScheduleTemplate: SCHEDULE_TEMPLATE_VERSION,
    name: s.name,
    ...(s.description && { description: s.description }),
    kind: s.kind,
    mode: s.mode,
    ...(s.mode === "tick" && { cron: s.cron_expr }),
    ...(s.kind === "prompt" ? { prompt: s.prompt } : { script: s.script ?? "", inputs }),
    ...(s.mode === "tick" && { timeoutMs: s.timeout_ms }),
    ...(s.max_turns != null && { maxTurns: s.max_turns }),
    permissionMode: s.permission_mode,
  };
  const body = s.kind === "prompt" ? s.prompt : (s.script ?? "");
  warnings.push(...machinePathWarnings(body, machinePaths));
  return { template: ordered(raw) as unknown as ScheduleTemplate, warnings };
}

export function serializeScheduleTemplate(template: ScheduleTemplate): string {
  return `${JSON.stringify(ordered(template as unknown as Record<string, unknown>), null, 2)}\n`;
}

export function scheduleTemplateFileName(name: string): string {
  const slug = name
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60) || "schedule";
  return `${slug}${SCHEDULE_TEMPLATE_SUFFIX}`;
}

function machinePathWarnings(body: string, machinePaths: string[]): string[] {
  const paths = machinePaths.filter((p) => p.length > 1);
  const warnings: string[] = [];
  body.split("\n").forEach((line, i) => {
    const hit = paths.find((p) => line.includes(p));
    if (hit && warnings.length < 20) warnings.push(`Line ${i + 1} mentions ${hit}, which only exists on this machine`);
  });
  return warnings;
}

/** The known fields of `data` in the written order, inputs included; absent fields stay absent. */
function ordered(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of FIELDS) {
    if (data[field] === undefined) continue;
    out[field] = field === "inputs" && Array.isArray(data.inputs)
      ? data.inputs.map((input) => pick(input as Record<string, unknown>, INPUT_ORDER))
      : data[field];
  }
  return out;
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
