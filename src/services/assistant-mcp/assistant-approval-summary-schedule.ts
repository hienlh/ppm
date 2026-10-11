import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import { exactFact, fact, modeLabel } from "./assistant-approval-summary.ts";

/**
 * The cards for the schedule tools. A schedule runs later with nobody watching, so what each
 * card shows is what will run: the prompt in full as the body (never a cut fact), the cron
 * with its next fire times and the zone they are in, the mode — and in bypass, a warning that
 * every run executes every tool unasked. Pure: the tools read and check everything first.
 */

/** A schedule's settings as a card shows them, the project by name with its folder. */
export interface ScheduleSettings {
  name: string;
  cron: string;
  project: string;
  folder: string;
  prompt: string;
  permissionMode: string;
  maxTurns: number | null;
  timeoutMs: number;
  enabled: boolean;
}

/** The next fire times, already formatted in the zone croner reads the cron in. */
export interface NextRuns {
  times: string[];
  timeZone: string;
}

export const SCHEDULE_BYPASS_WARNING = "Every run executes every tool without asking, with nobody watching.";

const providerName = (id: string): string => (id === "codex" ? "Codex" : id === "claude" ? "Claude" : id);

export const maxTurnsLabel = (n: number | null): string => (n === null ? "No limit" : `${n} turn${n === 1 ? "" : "s"}`);

export function timeoutLabel(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${Math.round(ms / 1000)} seconds`;
}

const enabledLabel = (on: boolean): string => (on ? "On" : "Paused");

function nextRunsText(next: NextRuns, enabled: boolean): string {
  if (!enabled) return "None while it is paused";
  if (next.times.length === 0) return "Never: this expression does not fire again";
  return `${next.times.join(", ")} (${next.timeZone})`;
}

const isBypass = (mode: string): boolean => mode === "bypassPermissions";

const runsIn = (mode: string, note = ""): ApprovalFact =>
  fact("Runs in", `${modeLabel(mode)}${note}`, isBypass(mode) ? "warning" : undefined);

const whereFacts = (s: ScheduleSettings): ApprovalFact[] => [exactFact("Project", s.project), exactFact("Folder", s.folder)];

export interface CreateScheduleCard {
  settings: ScheduleSettings;
  provider: string;
  nextRuns: NextRuns;
  /** False when the agent named no mode and the schedule gets the Settings form's default. */
  modeChosen: boolean;
}

export function createScheduleSummary({ settings: s, provider, nextRuns, modeChosen }: CreateScheduleCard): ApprovalSummary {
  return {
    headline: `Create the schedule "${s.name}" in "${s.project}"${s.enabled ? "" : " (paused)"}`,
    facts: [
      exactFact("Name", s.name),
      ...whereFacts(s),
      exactFact("Cron", s.cron),
      fact("Next runs", nextRunsText(nextRuns, s.enabled)),
      fact("Provider", `${providerName(provider)} (the default provider; the schedule keeps it)`),
      runsIn(s.permissionMode, modeChosen ? "" : " — the default, as in the Settings form"),
      fact("Max turns", maxTurnsLabel(s.maxTurns)),
      fact("Timeout", timeoutLabel(s.timeoutMs)),
      fact("Enabled", enabledLabel(s.enabled)),
    ],
    body: { label: "Prompt", text: s.prompt, format: "text" },
    ...(isBypass(s.permissionMode) ? { warning: SCHEDULE_BYPASS_WARNING } : {}),
  };
}

export type ScheduleField = keyof ScheduleSettings;

const FIELD_LABELS: Record<Exclude<ScheduleField, "folder" | "prompt">, string> = {
  name: "Name", cron: "Cron", project: "Project", permissionMode: "Mode", maxTurns: "Max turns", timeoutMs: "Timeout", enabled: "Enabled",
};

function fieldValue(s: ScheduleSettings, key: Exclude<ScheduleField, "folder" | "prompt">): string {
  switch (key) {
    case "project": return `${s.project} (${s.folder})`;
    case "permissionMode": return modeLabel(s.permissionMode);
    case "maxTurns": return maxTurnsLabel(s.maxTurns);
    case "timeoutMs": return timeoutLabel(s.timeoutMs);
    case "enabled": return enabledLabel(s.enabled);
    default: return s[key];
  }
}

export interface EditScheduleCard {
  id: number;
  before: ScheduleSettings;
  after: ScheduleSettings;
  /** The fields that differ, in the order they are listed. */
  changed: ScheduleField[];
  provider: string;
  nextRuns: NextRuns;
}

/**
 * Each change as "old → new". Pausing or turning on alone gets its own headline; turning on also
 * shows the prompt, since that is what starts running again.
 */
export function editScheduleSummary({ id, before, after, changed, provider, nextRuns }: EditScheduleCard): ApprovalSummary {
  const onlyEnabled = changed.length === 1 && changed[0] === "enabled";
  const promptChanged = changed.includes("prompt");
  const turnedOn = changed.includes("enabled") && after.enabled;
  const showNext = changed.includes("cron") || changed.includes("enabled");
  const changes = changed.filter((k): k is Exclude<ScheduleField, "folder" | "prompt"> => k !== "folder" && k !== "prompt");
  return {
    headline: onlyEnabled
      ? `${after.enabled ? "Turn on" : "Pause"} the schedule "${before.name}" in "${before.project}"`
      : `Change the schedule "${before.name}" in "${before.project}"`,
    facts: [
      exactFact("Schedule", `${before.name} (#${id})`),
      ...(changed.includes("project") ? [] : whereFacts(before)),
      ...changes.map((k) => exactFact(FIELD_LABELS[k], `${fieldValue(before, k)} → ${fieldValue(after, k)}`)),
      ...(promptChanged ? [fact("Prompt", "Changed — the new prompt is below")] : []),
      ...(showNext ? [fact("Next runs", nextRunsText(nextRuns, after.enabled))] : []),
      fact("Provider", providerName(provider)),
      ...(changed.includes("permissionMode") ? [] : [runsIn(after.permissionMode)]),
    ],
    ...(promptChanged || turnedOn ? { body: { label: promptChanged ? "New prompt" : "Prompt", text: after.prompt, format: "text" as const } } : {}),
    ...(isBypass(after.permissionMode) && after.enabled ? { warning: SCHEDULE_BYPASS_WARNING } : {}),
  };
}

export interface DeleteScheduleCard {
  id: number;
  settings: ScheduleSettings;
  /** Recorded runs deleted with it; `runsCapped` when there are at least that many. */
  runs: number;
  runsCapped: boolean;
}

export function deleteScheduleSummary({ id, settings: s, runs, runsCapped }: DeleteScheduleCard): ApprovalSummary {
  const count = runsCapped ? `${runs}+` : String(runs);
  return {
    headline: `Delete the schedule "${s.name}" in "${s.project}" and its run history`,
    facts: [
      exactFact("Schedule", `${s.name} (#${id})`),
      ...whereFacts(s),
      exactFact("Cron", s.cron),
      fact("Mode", modeLabel(s.permissionMode)),
      fact("Enabled", enabledLabel(s.enabled)),
      fact("Run history", runs === 0 ? "No recorded runs" : `${count} recorded run${runs === 1 && !runsCapped ? "" : "s"} deleted with it`, runs > 0 ? "warning" : undefined),
    ],
    body: { label: "Prompt", text: s.prompt, format: "text" },
    warning: "This cannot be undone: the schedule and its run history are deleted. The Assistant gets its settings back to recreate it, without the history.",
  };
}

export interface RunNowScheduleCard {
  id: number;
  settings: ScheduleSettings;
  /** The provider the schedule runs on (snapshotted when it was created). */
  provider: string;
  /** Its newest run is still going. */
  running: boolean;
}

export function runNowScheduleSummary({ id, settings: s, provider, running }: RunNowScheduleCard): ApprovalSummary {
  return {
    headline: `Run the schedule "${s.name}" now in "${s.project}"`,
    facts: [
      exactFact("Schedule", `${s.name} (#${id})`),
      ...whereFacts(s),
      fact("Provider", providerName(provider)),
      runsIn(s.permissionMode),
      ...(running ? [fact("Already running", "A run is in progress; this starts a second one alongside it", "warning")] : []),
    ],
    body: { label: "Prompt", text: s.prompt, format: "text" },
    ...(isBypass(s.permissionMode) ? { warning: SCHEDULE_BYPASS_WARNING } : {}),
  };
}
