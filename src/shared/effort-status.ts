/**
 * The effort a Claude session actually runs at, which is not always the one picked in PPM.
 *
 * Claude Code settles it in this order (measured against the bundled CLI's `get_settings`):
 * `CLAUDE_CODE_EFFORT_LEVEL` beats the `--effort` PPM passes, whether it is in the environment
 * or in the `env` block of a settings file, and a settings file beats the environment; a
 * `maxEffortLevel` in the settings then clamps what is left; and a model without a level runs
 * Extra and Max as High, or sends no effort at all. With
 * `"env": { "CLAUDE_CODE_EFFORT_LEVEL": "max" }` in `~/.claude/settings.json`, every PPM chat
 * ran at Max while the picker said High.
 */

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function effortRank(level: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(level);
}

/** A settings file, as the CLI names its sources, or the environment PPM starts the CLI with. */
export type EffortSettingSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "flagSettings"
  | "policySettings"
  | "environment";

export interface EffortSetting<T> {
  value: T;
  source: EffortSettingSource;
  /** The file it is written in, the way the user would look for it. */
  file?: string;
}

export interface EffortStatus {
  /** `CLAUDE_CODE_EFFORT_LEVEL` as the CLI reads it. Absent when unset or a value the CLI ignores. */
  env?: EffortSetting<string>;
  /** The lowest `maxEffortLevel` the settings files set for the session's model. */
  cap?: EffortSetting<EffortLevel>;
  /**
   * The running CLI's own answer: the effort it was started with and the one it sends. Only
   * the CLI knows its organization's limits and what its model takes, so this outranks the rest.
   */
  observed?: { requested: EffortLevel | null; applied: EffortLevel | null; model?: string };
  /** Levels the model runs as themselves, [] when it takes none. Absent when the CLI did not say. */
  supported?: EffortLevel[];
}

export type EffortEnvMeaning =
  | { kind: "level"; level: EffortLevel }
  /** `auto` or `unset`: no effort is sent and the model's default applies. */
  | { kind: "auto" }
  /** A number: a thinking budget, sent instead of an effort level. */
  | { kind: "budget" };

/** What the CLI makes of `CLAUDE_CODE_EFFORT_LEVEL`, parsed as it parses it; null for a value it ignores. */
export function effortEnvMeaning(raw: string | null | undefined): EffortEnvMeaning | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value === "auto" || value === "unset") return { kind: "auto" };
  const level = value === "med" ? "medium" : value;
  if (isEffortLevel(level)) return { kind: "level", level };
  return Number.isNaN(parseInt(value, 10)) ? null : { kind: "budget" };
}

export interface EffortInEffect {
  /** The level each request carries; null when none is sent. */
  level: EffortLevel | null;
  /** What decided it when that is not simply the pick. */
  reason: "env" | "cap" | "model" | null;
}

/** The effort a turn runs at given the level picked in PPM, and what overrides the pick if anything does. */
export function effortInEffect(pick: EffortLevel, status: EffortStatus | null | undefined): EffortInEffect {
  if (!status) return { level: pick, reason: null };
  const env = effortEnvMeaning(status.env?.value);
  const { observed } = status;
  if (env) {
    // The variable outranks every pick, so the CLI's answer stays true whatever is picked since.
    if (observed) return { level: observed.applied, reason: "env" };
    return { level: envLevel(env, status), reason: "env" };
  }
  // A pick made after the CLI last answered is checked against the limits it reported.
  const level = observed && observed.requested === pick ? observed.applied : withinLimits(pick, status);
  if (level === pick) return { level, reason: null };
  const capped = !!status.cap && effortRank(pick) > effortRank(status.cap.value);
  return { level, reason: capped ? "cap" : "model" };
}

/**
 * What the CLI makes of the variable before it has said so itself. A settings cap changes it:
 * `auto` then sends the model's default and a number is read as High, each clamped to the cap,
 * where without one neither sends an effort. The model's default is taken as High, the CLI's own
 * fallback, until the CLI answers.
 */
function envLevel(env: EffortEnvMeaning, status: EffortStatus): EffortLevel | null {
  if (env.kind === "level") return withinLimits(env.level, status);
  return status.cap ? withinLimits("high", status) : null;
}

function withinLimits(level: EffortLevel, status: EffortStatus): EffortLevel | null {
  if (status.supported?.length === 0) return null;
  const capped = status.cap && effortRank(level) > effortRank(status.cap.value) ? status.cap.value : level;
  // The CLI's own fallback for a model without Extra or Max.
  const unsupported = status.supported && !status.supported.includes(capped);
  return unsupported && (capped === "xhigh" || capped === "max") ? "high" : capped;
}

/** Where a setting lives, for a sentence that tells the user where to change it. */
export function effortSettingPlace(setting: EffortSetting<unknown>): string {
  if (setting.file) return setting.file;
  switch (setting.source) {
    case "userSettings": return "~/.claude/settings.json";
    case "projectSettings": return ".claude/settings.json";
    case "localSettings": return ".claude/settings.local.json";
    case "policySettings": return "managed settings";
    case "flagSettings": return "the settings PPM passes to Claude Code";
    case "environment": return "the environment PPM runs in";
  }
}
