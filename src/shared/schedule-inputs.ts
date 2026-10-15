/**
 * Input values of a script schedule. A value is kept apart from its declaration: the
 * non-secret ones in plain JSON, the secret ones encrypted on the server. These helpers are
 * the rules both halves share; none of them ever echoes a secret's value back.
 */
import type { ScheduleInputDecl, ScheduleInputValue } from "../types/scheduler.ts";
import { inputValueFits } from "./schedule-definition.ts";

/** A value to set, or null to clear it (back to the default; a cleared secret is unset). */
export type InputValuePatch = Record<string, ScheduleInputValue | null>;

const typeName = (decl: ScheduleInputDecl): string => (decl.type === "text" || decl.type === "secret" ? "text" : decl.type);

/** Problems with values a caller supplies: `values` for ordinary inputs, `secrets` for secret ones. */
export function inputValueProblems(decls: ScheduleInputDecl[], values: InputValuePatch, secrets: InputValuePatch = {}): string[] {
  const byKey = new Map(decls.map((d) => [d.key, d]));
  const errors: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const decl = byKey.get(key);
    if (!decl) errors.push(`No input named "${key}"`);
    else if (decl.type === "secret") errors.push(`"${key}" is a secret; set it as a secret`);
    else if (value !== null && !inputValueFits(decl, value)) errors.push(`"${key}" must be ${typeName(decl)}`);
  }
  for (const [key, value] of Object.entries(secrets)) {
    const decl = byKey.get(key);
    if (!decl) errors.push(`No input named "${key}"`);
    else if (decl.type !== "secret") errors.push(`"${key}" is not a secret`);
    else if (value !== null && (typeof value !== "string" || value === "")) errors.push(`The secret "${key}" must be non-empty text`);
  }
  return errors;
}

/** Text from a command line, as the type `decl` declares; an Error when it does not read as one. */
export function coerceInputValue(decl: ScheduleInputDecl, raw: string): ScheduleInputValue | Error {
  if (decl.type === "number") {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) ? n : new Error(`"${decl.key}" must be a number`);
  }
  if (decl.type === "boolean") {
    const v = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
    return new Error(`"${decl.key}" must be true or false`);
  }
  return raw;
}

/** Required inputs with nothing to run on: no value, no default, and for a secret, nothing saved. */
export function missingRequiredInputs(
  decls: ScheduleInputDecl[],
  values: Record<string, ScheduleInputValue>,
  secretsSet: readonly string[],
): string[] {
  return decls
    .filter((d) => d.required)
    .filter((d) => (d.type === "secret" ? !secretsSet.includes(d.key) : values[d.key] === undefined && d.default === undefined))
    .map((d) => d.key);
}

/**
 * Declarations in one spelling: fields in a fixed order, `required` only when true. Saved that
 * way, a form that sends back what it was given saves the same text, and an always-on process
 * is not restarted by a save that changed nothing.
 */
export function normalizeInputs(decls: ScheduleInputDecl[]): ScheduleInputDecl[] {
  return decls.map((d) => ({
    key: d.key,
    label: d.label,
    type: d.type,
    ...(d.required && { required: true }),
    ...(d.default !== undefined && { default: d.default }),
    ...(d.description && { description: d.description }),
  }));
}

/** What a script sees as `ctx.inputs`: the value, else the default, else undefined. */
export function resolveInputValues(
  decls: ScheduleInputDecl[],
  values: Record<string, ScheduleInputValue>,
  secrets: Record<string, string>,
): Record<string, ScheduleInputValue | undefined> {
  const out: Record<string, ScheduleInputValue | undefined> = {};
  for (const d of decls) out[d.key] = d.type === "secret" ? secrets[d.key] : (values[d.key] ?? d.default);
  return out;
}
