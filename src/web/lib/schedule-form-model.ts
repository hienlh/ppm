/**
 * The schedule form without React: its state, the body it sends, and what is wrong with it.
 * The rules are the server's own (`schedule-definition.ts`), so the form refuses before a round
 * trip what the server would. Secrets follow the server's patch rule: a blank field keeps what
 * is saved, and nothing saved is ever shown or sent back.
 */
import { definitionProblems, DEFAULT_TIMEOUT_MS } from "../../shared/schedule-definition";
import { missingRequiredInputs } from "../../shared/schedule-inputs";
import type {
  ScheduleInputDecl, ScheduleInputType, ScheduleInputValue, ScheduleKind, ScheduleMode, ScheduleView,
} from "../../types/scheduler";

/** An input declaration as typed: its default stays text until it is sent. */
export interface InputDraft {
  key: string;
  label: string;
  type: ScheduleInputType;
  required: boolean;
  default: string;
  description: string;
}

export interface ScheduleFormState {
  kind: ScheduleKind;
  mode: ScheduleMode;
  name: string;
  description: string;
  projectPath: string;
  cron: string;
  prompt: string;
  script: string;
  permissionMode: string;
  maxTurns: string;
  timeoutMs: string;
  enabled: boolean;
  inputs: InputDraft[];
  /** Non-secret values as typed; "" means none (the default applies). A boolean is "true" or "false". */
  values: Record<string, string>;
  /** Secrets typed now; "" keeps the saved one. */
  secrets: Record<string, string>;
}

export const DEFAULT_SCRIPT = `export default async (ctx) => {\n  ctx.log("Hello from", ctx.schedule.name);\n};\n`;

export function initialForm(s: ScheduleView | null): ScheduleFormState {
  return {
    kind: s?.kind ?? "prompt",
    mode: s?.mode ?? "tick",
    name: s?.name ?? "",
    description: s?.description ?? "",
    projectPath: s?.project_path ?? "",
    cron: s ? s.cron_expr : "0 7 * * *",
    prompt: s?.prompt ?? "",
    script: s?.script ?? DEFAULT_SCRIPT,
    permissionMode: s?.permission_mode ?? "bypassPermissions",
    maxTurns: s?.max_turns != null ? String(s.max_turns) : "",
    timeoutMs: String(s?.timeout_ms ?? DEFAULT_TIMEOUT_MS.prompt),
    enabled: s ? !!s.enabled : true,
    inputs: (s?.inputs ?? []).map(toDraft),
    values: Object.fromEntries(Object.entries(s?.inputValues ?? {}).map(([k, v]) => [k, String(v)])),
    secrets: {},
  };
}

/** A new schedule switched to `kind`: the timeout follows, unless it was typed. */
export function withKind(f: ScheduleFormState, kind: ScheduleKind): ScheduleFormState {
  const typed = f.timeoutMs !== String(DEFAULT_TIMEOUT_MS[f.kind]);
  return { ...f, kind, mode: kind === "prompt" ? "tick" : f.mode, timeoutMs: typed ? f.timeoutMs : String(DEFAULT_TIMEOUT_MS[kind]) };
}

export function toDraft(d: ScheduleInputDecl): InputDraft {
  return {
    key: d.key, label: d.label, type: d.type, required: !!d.required,
    default: d.default === undefined ? "" : String(d.default), description: d.description ?? "",
  };
}

/** Text as the type says; text that does not read as one is kept, for the rules to name. */
export function typedValue(type: ScheduleInputType, text: string): ScheduleInputValue {
  if (type === "number") return text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
  if (type === "boolean") return text === "true" ? true : text === "false" ? false : text;
  return text;
}

export function draftsToDecls(drafts: InputDraft[]): ScheduleInputDecl[] {
  return drafts.map((d) => ({
    key: d.key.trim(),
    label: d.label.trim(),
    type: d.type,
    ...(d.required && { required: true }),
    ...(d.default !== "" && d.type !== "secret" && { default: typedValue(d.type, d.default) }),
    ...(d.description.trim() && { description: d.description.trim() }),
  }));
}

/** Values to send for `decls`: each non-secret one set, or null to clear it. */
export function valuePatch(decls: ScheduleInputDecl[], values: Record<string, string>): Record<string, ScheduleInputValue | null> {
  return Object.fromEntries(decls.filter((d) => d.type !== "secret").map((d) => {
    const text = values[d.key] ?? "";
    return [d.key, text === "" ? null : typedValue(d.type, text)];
  }));
}

/** Only the secrets typed now: a blank one keeps what is saved. */
export function secretPatch(decls: ScheduleInputDecl[], secrets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(decls.filter((d) => d.type === "secret" && secrets[d.key]).map((d) => [d.key, secrets[d.key]!]));
}

/** The body of POST /api/schedules, or of PATCH /api/schedules/:id when `editing`. */
export function requestBody(f: ScheduleFormState, editing: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: f.name.trim(), description: f.description, project_path: f.projectPath,
    permission_mode: f.permissionMode, enabled: f.enabled, mode: f.mode,
    ...(!editing && { kind: f.kind }),
  };
  if (f.mode === "tick") Object.assign(body, { cron_expr: f.cron.trim(), timeout_ms: Number(f.timeoutMs) });
  if (f.kind === "prompt") return { ...body, prompt: f.prompt, max_turns: f.maxTurns === "" ? null : Number(f.maxTurns) };
  const decls = draftsToDecls(f.inputs);
  const secrets = secretPatch(decls, f.secrets);
  return {
    ...body, script: f.script, inputs: decls, inputValues: valuePatch(decls, f.values),
    ...(Object.keys(secrets).length > 0 && { secrets }),
  };
}

/** What is wrong with the form, one sentence each; `secretsSet` are the secrets already saved. */
export function formProblems(f: ScheduleFormState, secretsSet: readonly string[] = []): string[] {
  const problems: string[] = [];
  if (!f.name.trim()) problems.push("Give the schedule a name");
  if (!f.projectPath) problems.push("Pick a project");
  const decls = draftsToDecls(f.inputs);
  problems.push(...definitionProblems({
    kind: f.kind, mode: f.mode,
    cron: f.mode === "tick" ? f.cron.trim() : undefined,
    prompt: f.kind === "prompt" ? f.prompt : undefined,
    script: f.kind === "script" ? f.script : undefined,
    inputs: f.kind === "script" ? decls : undefined,
    timeoutMs: f.mode === "tick" ? Number(f.timeoutMs) : undefined,
    maxTurns: f.kind === "prompt" && f.maxTurns !== "" ? Number(f.maxTurns) : undefined,
    permissionMode: f.permissionMode,
  }));
  if (f.kind !== "script" || problems.length) return problems;
  problems.push(...valueProblems(decls, f.values));
  if (f.enabled) problems.push(...missingProblem(decls, f.values, [...secretsSet, ...Object.keys(secretPatch(decls, f.secrets))]));
  return problems;
}

/** Values typed that do not read as their input's type. */
export function valueProblems(decls: ScheduleInputDecl[], values: Record<string, string>): string[] {
  return decls
    .filter((d) => d.type === "number" && (values[d.key] ?? "") !== "" && typeof typedValue("number", values[d.key]!) !== "number")
    .map((d) => `${d.label} must be a number`);
}

function missingProblem(decls: ScheduleInputDecl[], values: Record<string, string>, secretsSet: string[]): string[] {
  const set = Object.fromEntries(Object.entries(valuePatch(decls, values)).filter((e): e is [string, ScheduleInputValue] => e[1] !== null));
  const missing = missingRequiredInputs(decls, set, secretsSet);
  return missing.length ? [`Fill in ${missing.join(", ")} before turning it on`] : [];
}
