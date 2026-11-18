/**
 * A script schedule an AI proposes: checked here, before any card is built, by the same rules the
 * routes, the CLI and template import follow (`schedule-definition.ts`, then a dry run of
 * `newScheduleFrom`), so a card never shows a schedule the save would refuse.
 *
 * The proposal is then frozen: the card is built from it, and the schedule is created from the
 * same object (`proposalRouteBody`), so what is stored is what the card showed. `matchesProposal`
 * checks the stored row against it once more after the save.
 *
 * Given either as fields or as a `.ppm-schedule.json` file (`file`), parsed strictly like an
 * import, except that a proposal file may also carry `values`: this machine's input values, which
 * a shared template never holds. The tool's `inputValues` override them, and both go through the
 * same checks and onto the card alike. A secret's value never comes from an AI or a file.
 */
import { definitionProblems, DEFAULT_TIMEOUT_MS, SCHEDULE_LIMITS } from "../../shared/schedule-definition.ts";
import { parseScheduleTemplate } from "../../shared/schedule-template.ts";
import { normalizeInputs } from "../../shared/schedule-inputs.ts";
import { canonicalZone, timezoneProblem } from "../../shared/session-schedule-input.ts";
import { cronProblem } from "../../shared/schedule-cron.ts";
import type { Schedule, ScheduleInputDecl, ScheduleInputValue, ScheduleMode } from "../../types/scheduler.ts";
import { newScheduleFrom, ScheduleEditError } from "../scheduler-edit.ts";
import { readProposalFile, type ProposalFile } from "./script-proposal-file.ts";
import { turnSecretScrubber } from "../vault/turn-secret-scrubber.ts";

/** What a new schedule's AI turns run in when the proposal names no mode: the Settings form's default. */
export const DEFAULT_PROPOSAL_MODE = "bypassPermissions";

export interface ScriptScheduleProposal {
  name: string;
  description: string;
  mode: ScheduleMode;
  /** Null for an always-on script. */
  cron: string | null;
  /** Canonical IANA zone the cron is read in; null is the machine's own. */
  timezone: string | null;
  script: string;
  inputs: ScheduleInputDecl[];
  /** The values set for non-secret inputs; an input left out runs on its default. */
  inputValues: Record<string, ScheduleInputValue>;
  /** Null for an always-on script. */
  timeoutMs: number | null;
  permissionMode: string;
  modeChosen: boolean;
  project: { name: string; path: string };
  /** Set when the proposal came from a file: the card names it, and a changed file creates nothing. */
  file: Pick<ProposalFile, "path" | "sha256"> | null;
}

export type ProposalParse = { ok: true; proposal: ScriptScheduleProposal } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The template fields a proposal given as fields takes, in the template's spelling. */
const FIELD_ARGS = ["name", "description", "mode", "cron", "script", "inputs", "timeoutMinutes", "permissionMode"] as const;

function refused(problems: string[]): ProposalParse {
  return { ok: false, error: `Not proposed: ${problems.join("; ")}.` };
}

/**
 * `args` as a proposal for `project`. `fileRoots` are the folders a `file` may be in; `where` names
 * them in an error.
 */
export function parseScriptProposal(
  args: Record<string, unknown>,
  project: { name: string; path: string },
  providerId: string,
  fileRoots: readonly string[],
  where?: string,
): ProposalParse {
  let def: Record<string, unknown>;
  let file: ScriptScheduleProposal["file"] = null;
  let fileValues: Record<string, unknown> = {};
  if (args.file !== undefined) {
    const given = FIELD_ARGS.filter((k) => args[k] !== undefined);
    if (given.length) return refused([`give either \`file\` or the fields, not both (${given.join(", ")} given with file)`]);
    const read = readProposalFile(args.file, fileRoots, where);
    if (!read.ok) return { ok: false, error: `Not proposed: ${read.error}` };
    // A proposal file may carry this machine's input values beside the template (`values`), which
    // a shared template never does: they are taken out here, and the rest is parsed as strictly as
    // an import. They then go through every check `inputValues` does, below.
    const split = splitFileValues(read.file.text);
    if (!split.ok) return refused([split.error]);
    const parsed = parseScheduleTemplate(split.template);
    if (!parsed.ok) return { ok: false, error: `Not proposed: the file is not a valid schedule template: ${parsed.errors.join("; ")}.` };
    def = { ...parsed.template };
    fileValues = split.values;
    file = { path: read.file.path, sha256: read.file.sha256 };
  } else {
    const minutes = args.timeoutMinutes;
    def = {
      name: args.name, description: args.description, kind: "script", mode: args.mode ?? "tick",
      cron: args.cron, script: args.script, inputs: args.inputs ?? [], permissionMode: args.permissionMode,
      ...(minutes !== undefined && { timeoutMs: typeof minutes === "number" && Number.isFinite(minutes) ? Math.round(minutes * 60_000) : minutes }),
    };
    if (typeof def.name !== "string" || !def.name.trim() || def.name.length > SCHEDULE_LIMITS.name) {
      return refused([`name must be 1-${SCHEDULE_LIMITS.name} characters`]);
    }
    if (def.description !== undefined && (typeof def.description !== "string" || def.description.length > SCHEDULE_LIMITS.description)) {
      return refused([`description must be text of at most ${SCHEDULE_LIMITS.description} characters`]);
    }
    const problems = definitionProblems(def);
    if (problems.length) return refused(problems);
  }
  if (def.kind !== "script") return refused(["only a script schedule can be proposed here (kind \"script\")"]);

  const mode = def.mode as ScheduleMode;
  const zoneProblem = timezoneProblem(args.timezone);
  if (zoneProblem) return refused([zoneProblem]);
  if (args.timezone && mode !== "tick") return refused(["an always-on script has no cron, so no time zone"]);
  const timezone = mode === "tick" ? canonicalZone(args.timezone) : null;
  const cron = mode === "tick" ? (def.cron as string).trim().split(/\s+/).join(" ") : null;
  if (cron && timezone) {
    const problem = cronProblem(cron, "script", timezone);
    if (problem) return refused([problem]);
  }

  const inputs = normalizeInputs((def.inputs ?? []) as ScheduleInputDecl[]);
  const given = args.inputValues ?? {};
  if (!isObj(given)) return refused(["inputValues must be an object of input key to value"]);
  // The tool's own values win over the file's; both pass the same checks, named by where they came from.
  const values: Record<string, unknown> = { ...fileValues, ...given };
  for (const key of Object.keys(values)) {
    const from = Object.hasOwn(given, key) ? "inputValues" : "the file's values";
    const decl = inputs.find((d) => d.key === key);
    if (!decl) return refused([`${from} names "${key}", which the script does not declare`]);
    if (decl.type === "secret") return refused([`"${key}" is a secret input: its value is set by the user in Settings → Schedules, never by an AI or a file`]);
    if (values[key] === null) return refused([`${from} gives "${key}" null; leave it out to run on the input's default`]);
  }
  const requiredSecret = inputs.find((d) => d.type === "secret" && d.required);
  if (requiredSecret) {
    return refused([`the secret input "${requiredSecret.key}" is required and an AI cannot set it; the user imports this one in Settings → Schedules`]);
  }

  const permissionMode = typeof def.permissionMode === "string" ? def.permissionMode : DEFAULT_PROPOSAL_MODE;
  const proposal: ScriptScheduleProposal = {
    name: (def.name as string).trim(),
    description: typeof def.description === "string" ? def.description : "",
    mode, cron, timezone,
    script: def.script as string,
    inputs,
    inputValues: { ...(values as Record<string, ScheduleInputValue>) },
    timeoutMs: mode === "tick" ? (typeof def.timeoutMs === "number" ? def.timeoutMs : DEFAULT_TIMEOUT_MS.script) : null,
    permissionMode,
    modeChosen: typeof def.permissionMode === "string",
    project,
    file,
  };
  // A value of the vault's locked tiers read in any chat never goes into a schedule, whether it
  // came in the arguments or in a file (the endpoint only scans the arguments).
  const leaked = turnSecretScrubber.findIn({ name: proposal.name, description: proposal.description, script: proposal.script, inputs: proposal.inputs, inputValues: proposal.inputValues });
  if (leaked) return refused([`it contains the value of the vault item "${leaked}"; vault values never go into a schedule, so refer to the item by name or let the user set it in Settings → Schedules`]);
  // The route's own rules, run dry: value types, required inputs, the cron in its zone.
  try {
    newScheduleFrom(proposalRouteBody(proposal), providerId);
  } catch (e) {
    if (e instanceof ScheduleEditError) return refused(e.problems);
    return { ok: false, error: `Not proposed: ${(e as Error).message}` };
  }
  return { ok: true, proposal: Object.freeze(proposal) };
}

/**
 * A proposal file's text split into the template and its `values`. Text that is not JSON goes on
 * whole, so the template parser answers it (never quoting it: a file picked by mistake can hold a token).
 */
function splitFileValues(text: string): { ok: true; template: unknown; values: Record<string, unknown> } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: true, template: text, values: {} };
  }
  if (!isObj(data) || !("values" in data)) return { ok: true, template: data, values: {} };
  const { values, ...template } = data;
  if (!isObj(values)) return { ok: false, error: "the file's values must be an object of input key to value" };
  return { ok: true, template, values };
}

/** The body `POST /api/schedules` saves `p` from: every value explicit, created on. */
export function proposalRouteBody(p: ScriptScheduleProposal): Record<string, unknown> {
  return {
    kind: "script", mode: p.mode, name: p.name, description: p.description,
    cron_expr: p.cron ?? "", script: p.script, inputs: p.inputs, inputValues: p.inputValues,
    ...(p.timeoutMs !== null && { timeout_ms: p.timeoutMs }),
    permission_mode: p.permissionMode, project_path: p.project.path,
    ...(p.timezone && { timezone: p.timezone }),
    enabled: true,
  };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Two flat records holding the same keys and values, whatever their key order. */
const sameRecord = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => k in b && a[k] === b[k]);

/** The first field where the stored `row` is not what the card showed, or null when it is. */
export function proposalMismatch(row: Schedule, p: ScriptScheduleProposal, providerId: string): string | null {
  const checks: Array<[string, boolean]> = [
    ["kind", row.kind === "script"],
    ["mode", row.mode === p.mode],
    ["name", row.name === p.name],
    ["description", row.description === p.description],
    ["cron", row.cron_expr === (p.cron ?? "")],
    ["time zone", (row.timezone ?? null) === p.timezone],
    ["script", row.script === p.script],
    ["inputs", sameJson(JSON.parse(row.inputs_json), p.inputs)],
    ["input values", sameRecord(JSON.parse(row.input_values_json), p.inputValues)],
    ["folder", row.project_path === p.project.path],
    ["mode of its AI turns", row.permission_mode === p.permissionMode],
    ["timeout", p.timeoutMs === null || row.timeout_ms === p.timeoutMs],
    ["provider", row.provider_id === providerId],
    ["enabled", row.enabled === 1],
  ];
  return checks.find(([, same]) => !same)?.[0] ?? null;
}
