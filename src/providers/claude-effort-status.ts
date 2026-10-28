/**
 * What decides a Claude session's effort besides the pick, worked out from the same settings
 * the CLI reads. The live answer comes from the running CLI (`readEffortStatus` in the
 * provider); until a turn has started one, `estimateEffortStatus` reads the settings files
 * the CLI would, which is enough for the common overrides and is replaced by the CLI's own
 * answer as soon as there is one.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  effortEnvMeaning, effortRank, isEffortLevel,
  type EffortLevel, type EffortSetting, type EffortSettingSource, type EffortStatus,
} from "../shared/effort-status.ts";

export const EFFORT_ENV_VAR = "CLAUDE_CODE_EFFORT_LEVEL";

/** One entry of `get_settings`'s `sources`, which the CLI orders from lowest priority to highest. */
export interface CliSettingsSource {
  source: string;
  settings: Record<string, unknown>;
}

/**
 * The part of the `get_settings` answer read here. `getSettings()` is on the SDK's `Query`
 * object but left out of `sdk.d.ts`, which is why this is typed here; a test asserts the SDK
 * still has it, so an upgrade that renames it fails loudly instead of the status going quiet.
 */
export interface CliSettingsAnswer {
  sources?: Array<CliSettingsSource | null>;
  /** What the session sends after env overrides, caps and model downgrades. */
  applied?: { model?: string; effort?: string | null };
}

/** A model as the CLI's `initialize` answer lists it. */
export interface CliModelInfo {
  value: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
}

export interface EffortSettingsQuery {
  getSettings(): Promise<CliSettingsAnswer>;
  initializationResult(): Promise<{ models?: CliModelInfo[] }>;
}

/** Where the CLI keeps its user settings; `~` stands in for the home folder in what is shown. */
export function userSettingsFile(env: Record<string, string | undefined>, home = homedir()): { path: string; shown: string } {
  const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const path = join(dir, "settings.json");
  return { path, shown: path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path };
}

const FILE_OF: Partial<Record<EffortSettingSource, string>> = {
  projectSettings: ".claude/settings.json",
  localSettings: ".claude/settings.local.json",
};

function place(source: string, userFile: string): Pick<EffortSetting<unknown>, "source" | "file"> {
  const known = source as EffortSettingSource;
  const file = source === "userSettings" ? userFile : FILE_OF[known];
  return { source: known, ...(file && { file }) };
}

/** `modelSettings` keys name a model the way its dated, `[1m]`, Bedrock and Vertex spellings all match. */
function modelKey(model: string): string {
  return model.toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/@.*$/, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/^(?:[a-z-]+\.)?anthropic\./, "")
    .replace(/-\d{8}$/, "");
}

/** A source's own cap for the model: a matching `modelSettings` entry replaces its `maxEffortLevel`. */
function sourceCap(settings: Record<string, unknown>, model: string | undefined): unknown {
  const perModel = settings.modelSettings;
  if (model && perModel && typeof perModel === "object") {
    const key = modelKey(model);
    let lowest: EffortLevel | undefined;
    for (const [name, entry] of Object.entries(perModel as Record<string, unknown>)) {
      const level = (entry as { maxEffortLevel?: unknown } | null)?.maxEffortLevel;
      if (modelKey(name) !== key || !isEffortLevel(level)) continue;
      if (!lowest || effortRank(level) < effortRank(lowest)) lowest = level;
    }
    if (lowest) return lowest;
  }
  return settings.maxEffortLevel;
}

/**
 * The overrides the settings and the environment hold: the `CLAUDE_CODE_EFFORT_LEVEL` that wins
 * (the highest-priority settings file that sets it, else the environment, which every settings
 * file outranks) and the lowest cap (across files the lowest wins, and "max" caps nothing).
 */
export function effortOverrides(p: {
  sources: ReadonlyArray<CliSettingsSource | null | undefined>;
  processEnv?: string;
  model?: string;
  userFile: string;
}): Pick<EffortStatus, "env" | "cap"> {
  const out: Pick<EffortStatus, "env" | "cap"> = {};
  const sources = p.sources.filter((s): s is CliSettingsSource => !!s?.settings && typeof s.settings === "object");

  let env: EffortSetting<string> | undefined;
  for (let i = sources.length - 1; i >= 0 && !env; i--) {
    const value = (sources[i]!.settings.env as Record<string, unknown> | undefined)?.[EFFORT_ENV_VAR];
    if (typeof value === "string") env = { value, ...place(sources[i]!.source, p.userFile) };
  }
  env ??= p.processEnv !== undefined ? { value: p.processEnv, source: "environment" } : undefined;
  // A value the CLI ignores overrides nothing — but it still hides a lower one, as it does there.
  if (env && effortEnvMeaning(env.value)) out.env = env;

  for (const s of sources) {
    const level = sourceCap(s.settings, p.model);
    if (!isEffortLevel(level) || level === "max") continue;
    if (!out.cap || effortRank(level) < effortRank(out.cap.value)) out.cap = { value: level, ...place(s.source, p.userFile) };
  }
  return out;
}

function levels(values: unknown): EffortLevel[] {
  return Array.isArray(values) ? values.filter(isEffortLevel) : [];
}

/** The model's levels, from the `initialize` answer; undefined when it lists no such model. */
export function supportedLevels(models: CliModelInfo[] | undefined, model: string | undefined): EffortLevel[] | undefined {
  if (!models || !model) return undefined;
  const bare = (name: string) => name.toLowerCase().replace(/\[[^\]]*\]$/, "");
  const hit = models.find((m) => [m.value, m.resolvedModel].some((name) => name && bare(name) === bare(model)));
  return hit ? levels(hit.supportedEffortLevels) : undefined;
}

/** The running CLI's answer, as a status: its overrides plus what it said it sends. */
export function effortStatusFromCli(p: {
  answer: CliSettingsAnswer;
  models?: CliModelInfo[];
  requested: string | null | undefined;
  processEnv?: string;
  userFile: string;
}): EffortStatus {
  const model = typeof p.answer.applied?.model === "string" ? p.answer.applied.model : undefined;
  const applied = p.answer.applied?.effort;
  const supported = supportedLevels(p.models, model);
  return {
    ...effortOverrides({ sources: p.answer.sources ?? [], processEnv: p.processEnv, model, userFile: p.userFile }),
    observed: {
      requested: isEffortLevel(p.requested) ? p.requested : null,
      applied: isEffortLevel(applied) ? applied : null,
      ...(model && { model }),
    },
    ...(supported && { supported }),
  };
}

/** The settings files a chat in `projectPath` reads, lowest priority first; a file that does not parse is skipped, as the CLI skips it. */
export function readSettingsFiles(projectPath: string | undefined, userPath: string): CliSettingsSource[] {
  const files: Array<[EffortSettingSource, string]> = [["userSettings", userPath]];
  if (projectPath) {
    files.push(
      ["projectSettings", join(projectPath, ".claude", "settings.json")],
      ["localSettings", join(projectPath, ".claude", "settings.local.json")],
    );
  }
  const out: CliSettingsSource[] = [];
  for (const [source, file] of files) {
    let settings: unknown;
    try { settings = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (settings && typeof settings === "object" && !Array.isArray(settings)) out.push({ source, settings: settings as Record<string, unknown> });
  }
  return out;
}

/**
 * The overrides a chat in `projectPath` will meet, from the files alone — for a session no CLI
 * has answered for yet. Managed settings and organization limits are left to the CLI's answer.
 */
export function estimateEffortStatus(p: {
  projectPath?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}): EffortStatus {
  const env = p.env ?? process.env;
  const user = userSettingsFile(env, p.home);
  return effortOverrides({
    sources: readSettingsFiles(p.projectPath, user.path),
    processEnv: env[EFFORT_ENV_VAR],
    model: p.model,
    userFile: user.shown,
  });
}
