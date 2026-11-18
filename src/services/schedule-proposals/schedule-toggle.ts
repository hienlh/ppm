/**
 * Pausing or turning on a schedule from a chat's tool: the card for one of the project's schedules
 * and the write itself, which goes through the same functions the PATCH route uses
 * (`patchSessionSchedule` for a chat's reminder, `scheduleChangesFrom` for the rest).
 *
 * Turning on a script starts code running unattended again, so that card shows the whole script and
 * is allowed only in PPM, as a proposal's is. Pausing stops something, and turning on a prompt
 * schedule shows the prompt like the Assistant's own card does; both follow the ordinary rule
 * (Allow away from PPM only when the whole card fits).
 */
import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { exactFact, fact, modeLabel } from "../assistant-mcp/assistant-approval-summary.ts";
import { SCHEDULE_BYPASS_WARNING } from "../assistant-mcp/assistant-approval-summary-schedule.ts";
import { getSchedule, updateSchedule } from "../scheduler-db.service.ts";
import { scheduleChangesFrom } from "../scheduler-edit.ts";
import { patchSessionSchedule } from "../session-schedules/session-schedule-save.ts";
import { SCRIPT_REVIEW_IN_PPM, SCRIPT_UNATTENDED_WARNING, type ProposalCardDeps } from "./script-proposal-card.ts";

const KIND_WORDS: Record<Schedule["kind"], string> = { script: "script", prompt: "prompt", session: "chat reminder" };

function whenFacts(s: Schedule, deps: ProposalCardDeps): ApprovalFact[] {
  if (s.mode === "always-on") return [fact("Runs", "Always on: PPM keeps it running and starts it again after a crash")];
  const zone = s.timezone ?? deps.machineZone;
  const runs = deps.nextRuns(s.cron_expr, s.timezone, 3);
  return [
    exactFact("Cron", s.cron_expr),
    exactFact("Time zone", s.timezone ? zone : `${zone} (this machine's)`),
    fact("Next 3 runs", runs.length ? `${runs.join(", ")} (${zone})` : "Never: this expression does not fire again"),
  ];
}

/** The card for turning `s` on or pausing it; `project` is the registered project its folder is. */
export function scheduleToggleSummary(s: Schedule, enabled: boolean, project: string, deps: ProposalCardDeps): ApprovalSummary {
  const kind = KIND_WORDS[s.kind];
  const startsScript = enabled && s.kind === "script";
  const bypass = s.permission_mode === "bypassPermissions";
  const body = enabled
    ? s.kind === "script" ? { label: "Script (runs exactly as shown)", text: s.script ?? "", format: "code" as const }
      : { label: "Prompt", text: s.prompt, format: "text" as const }
    : undefined;
  return {
    headline: `${enabled ? "Turn on" : "Pause"} the ${kind} schedule "${s.name}" in "${project}"`,
    facts: [
      exactFact("Schedule", `${s.name} (#${s.id})`),
      fact("Kind", s.mode === "always-on" ? `${kind}, always on` : kind),
      exactFact("Project", project),
      exactFact("Runs in folder", s.project_path),
      ...(enabled ? whenFacts(s, deps) : [fact("While paused", "It does not run; nothing else about it changes")]),
      ...(enabled && s.kind !== "session" ? [fact("Its AI turns run in", modeLabel(s.permission_mode), bypass ? "warning" : undefined)] : []),
    ],
    ...(body ? { body } : {}),
    ...(startsScript ? { warning: SCRIPT_UNATTENDED_WARNING, reviewInPpm: SCRIPT_REVIEW_IN_PPM }
      : enabled && bypass && s.kind === "prompt" ? { warning: SCHEDULE_BYPASS_WARNING } : {}),
  };
}

/** Turns `current` on or off as the PATCH route would, and answers it as stored. */
export function setScheduleEnabled(current: Schedule, enabled: boolean): Schedule {
  if (current.kind === "session") return patchSessionSchedule(current, { enabled });
  updateSchedule(current.id, scheduleChangesFrom(current, { enabled }));
  return getSchedule(current.id)!;
}
