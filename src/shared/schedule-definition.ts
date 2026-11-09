/**
 * What makes a schedule definition valid: one set of rules for the routes, the CLI, the browser
 * form and template import, so a template that imports is one the form would have accepted.
 * Fields use the template's spelling (`cron`, `timeoutMs`…); the routes translate theirs.
 */
import { VALID_PERMISSION_MODES } from "../types/config.ts";
import type { ScheduleInputDecl, ScheduleInputValue, ScheduleKind, ScheduleMode } from "../types/scheduler.ts";
import { cronProblem } from "./schedule-cron.ts";

export const SCHEDULE_LIMITS = {
  name: 100,
  description: 2000,
  prompt: 100_000,
  scriptBytes: 1_000_000,
  inputs: 50,
  inputLabel: 100,
  inputDescription: 500,
  minTimeoutMs: 10_000,
  maxTimeoutMs: 6 * 60 * 60_000,
} as const;

export const DEFAULT_TIMEOUT_MS: Record<ScheduleKind, number> = { prompt: 1_800_000, script: 300_000 };

export interface ScheduleDefinition {
  kind: ScheduleKind;
  mode: ScheduleMode;
  cron?: string;
  prompt?: string;
  script?: string;
  inputs?: ScheduleInputDecl[];
  timeoutMs?: number;
  maxTurns?: number;
  permissionMode?: string;
}

const INPUT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const INPUT_TYPES: readonly string[] = ["text", "number", "boolean", "secret"];
const INPUT_FIELDS = new Set(["key", "label", "type", "required", "default", "description"]);

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Whether `value` has the type `decl` says (a secret is a string). */
export function inputValueFits(decl: Pick<ScheduleInputDecl, "type">, value: unknown): value is ScheduleInputValue {
  if (decl.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (decl.type === "boolean") return typeof value === "boolean";
  return typeof value === "string";
}

/** Every problem with a list of input declarations, one sentence each. */
export function inputDeclProblems(inputs: unknown): string[] {
  if (!Array.isArray(inputs)) return ["inputs must be a list"];
  const errors: string[] = [];
  if (inputs.length > SCHEDULE_LIMITS.inputs) errors.push(`At most ${SCHEDULE_LIMITS.inputs} inputs`);
  const seen = new Set<string>();
  inputs.forEach((input, i) => {
    const at = `inputs[${i}]`;
    if (!isPlainObject(input)) { errors.push(`${at} must be an object`); return; }
    for (const field of Object.keys(input)) if (!INPUT_FIELDS.has(field)) errors.push(`${at}: unknown field "${field}"`);
    const { key, label, type, required, description } = input;
    if (typeof key !== "string" || !INPUT_KEY.test(key)) errors.push(`${at}: key must be a letter or _ followed by letters, digits or _ (64 at most)`);
    else if (seen.has(key)) errors.push(`${at}: key "${key}" is declared twice`);
    else seen.add(key);
    const name = typeof key === "string" ? `input "${key}"` : at;
    if (typeof label !== "string" || !label.trim() || label.length > SCHEDULE_LIMITS.inputLabel) errors.push(`${name}: label must be 1-${SCHEDULE_LIMITS.inputLabel} characters`);
    if (typeof type !== "string" || !INPUT_TYPES.includes(type)) errors.push(`${name}: type must be text, number, boolean or secret`);
    if (required !== undefined && typeof required !== "boolean") errors.push(`${name}: required must be true or false`);
    if (description !== undefined && (typeof description !== "string" || description.length > SCHEDULE_LIMITS.inputDescription)) {
      errors.push(`${name}: description must be text of at most ${SCHEDULE_LIMITS.inputDescription} characters`);
    }
    if ("default" in input) {
      if (type === "secret") errors.push(`${name}: a secret cannot have a default, or the file would be sharing it`);
      else if (typeof type === "string" && INPUT_TYPES.includes(type) && !inputValueFits({ type: type as ScheduleInputDecl["type"] }, input.default)) {
        errors.push(`${name}: default must be a ${type === "text" ? "string" : type}`);
      }
    }
  });
  return errors;
}

/** Every problem with `def`, one sentence each; empty when it is a valid schedule. */
export function definitionProblems(def: Record<string, unknown>): string[] {
  const { kind, mode, cron, prompt, script, inputs, timeoutMs, maxTurns, permissionMode } = def;
  if (kind !== "prompt" && kind !== "script") return ['kind must be "prompt" or "script"'];
  const errors: string[] = [];
  if (mode !== "tick" && mode !== "always-on") errors.push('mode must be "tick" or "always-on"');
  else if (kind === "prompt" && mode !== "tick") errors.push("A prompt schedule runs on a cron; it cannot be always on");

  if (mode === "tick") {
    if (typeof cron !== "string" || !cron.trim()) errors.push("A tick schedule needs a cron expression");
    else {
      const problem = cronProblem(cron, kind);
      if (problem) errors.push(problem);
    }
  } else if (mode === "always-on" && cron !== undefined && cron !== "") {
    errors.push("An always-on schedule has no cron expression");
  }

  if (kind === "prompt") {
    if (typeof prompt !== "string" || !prompt.trim()) errors.push("A prompt schedule needs a prompt");
    else if (prompt.length > SCHEDULE_LIMITS.prompt) errors.push(`The prompt is longer than ${SCHEDULE_LIMITS.prompt} characters`);
    if (script !== undefined && script !== null && script !== "") errors.push("A prompt schedule has no script");
    if (Array.isArray(inputs) ? inputs.length > 0 : inputs !== undefined) errors.push("Only a script schedule has inputs");
  } else {
    if (typeof script !== "string" || !script.trim()) errors.push("A script schedule needs a script");
    else if (utf8Length(script) > SCHEDULE_LIMITS.scriptBytes) errors.push("The script is larger than 1 MB");
    if (prompt !== undefined && prompt !== "") errors.push("A script schedule has no prompt");
    if (inputs !== undefined) errors.push(...inputDeclProblems(inputs));
  }

  if (timeoutMs !== undefined) {
    if (mode === "always-on") errors.push("An always-on schedule has no run timeout");
    else if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < SCHEDULE_LIMITS.minTimeoutMs || (timeoutMs as number) > SCHEDULE_LIMITS.maxTimeoutMs) {
      errors.push("timeoutMs must be a whole number of milliseconds between 10 seconds and 6 hours");
    }
  }
  // A script's ctx.ai.chat turn runs on the chat's own settings: its turn cap belongs to the
  // chat's process, shared with whoever else writes there, so a schedule cannot set one.
  if (maxTurns !== undefined && kind === "script") errors.push("Only a prompt schedule has maxTurns");
  else if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || (maxTurns as number) < 1)) errors.push("maxTurns must be a whole number of at least 1");
  if (permissionMode !== undefined && !(VALID_PERMISSION_MODES as readonly unknown[]).includes(permissionMode)) {
    errors.push(`permissionMode must be one of ${VALID_PERMISSION_MODES.join(", ")}`);
  }
  return errors;
}
