/**
 * Creating an approved proposal, and what the card's facts are read from on a live server.
 *
 * Before the save, what the card could not freeze is checked again: the file it came from and the
 * default provider the schedule snapshots. Anything that moved creates nothing. (The folder is the
 * proposal's own, frozen with it; a project renamed meanwhile keeps the folder the card named.) After the save the stored row is compared with the proposal; a row that differs is
 * deleted again rather than left running something the user did not see.
 */
import { getSessionProjectPath, getSessionTitle } from "../db.service.ts";
import { deleteSchedule, getSchedule, insertSchedule } from "../scheduler-db.service.ts";
import { newScheduleFrom } from "../scheduler-edit.ts";
import { liveScheduleTargetDeps } from "../session-schedules/session-schedule-target.ts";
import { nextRunTimes } from "../assistant-mcp/assistant-schedule-shape.ts";
import { cronFieldCount, nextFires } from "../../shared/schedule-cron.ts";
import type { Schedule } from "../../types/scheduler.ts";
import type { ProposalCardDeps } from "./script-proposal-card.ts";
import { proposalFileUnchanged } from "./script-proposal-file.ts";
import { proposalMismatch, proposalRouteBody, type ScriptScheduleProposal } from "./script-proposal.ts";

/**
 * The next `n` fires on `zone`'s clock (the machine's when null). A 6-field cron fires within one
 * minute several times, so its times carry seconds; a 5-field one keeps the minute form.
 */
export function nextRunsOnClock(cron: string, zone: string | null, n: number): string[] {
  if (cronFieldCount(cron) !== 6) return nextRunTimes(cron, n, zone);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone ?? undefined, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  return nextFires(cron, n, undefined, zone).map((d) => fmt.format(d).replace(", ", " "));
}

export const liveProposalCardDeps = (): ProposalCardDeps => ({
  nextRuns: nextRunsOnClock,
  machineZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "server local time",
  chat: (sessionId) => {
    const id = liveScheduleTargetDeps.canonical(sessionId);
    const path = liveScheduleTargetDeps.stored(id, getSessionProjectPath);
    const title = liveScheduleTargetDeps.stored(id, getSessionTitle);
    if (!path && !title) return null;
    return { title, projectName: path ? liveScheduleTargetDeps.projectByPath(path)?.name ?? null : null };
  },
});

/** Why the approved proposal can no longer be created as the card showed it, or null. */
export function proposalStaleReason(p: ScriptScheduleProposal, providerIdShown: string, providerIdNow: string): string | null {
  if (p.file && !proposalFileUnchanged(p.file)) return `The file ${p.file.path} changed (or went) after the card was shown.`;
  if (providerIdNow !== providerIdShown) return "The default provider changed while the card waited.";
  return null;
}

export type ProposalCreate = { ok: true; schedule: Schedule } | { ok: false; error: string };

/** Saves the approved proposal through the route's own function and checks what was stored. */
export function createProposedSchedule(p: ScriptScheduleProposal, providerId: string): ProposalCreate {
  let id: number;
  try {
    id = insertSchedule(newScheduleFrom(proposalRouteBody(p), providerId));
  } catch (e) {
    return { ok: false, error: `Not created: ${(e as Error).message}` };
  }
  // The caller announces the change (re-arm, refresh open lists) once it has answered.
  return verifyCreated(id, p, providerId);
}

/** The stored row `id` if it is what the card showed; otherwise it is deleted again. */
export function verifyCreated(id: number, p: ScriptScheduleProposal, providerId: string): ProposalCreate {
  const row = getSchedule(id);
  const mismatch = row ? proposalMismatch(row, p, providerId) : "the schedule itself";
  if (!row || mismatch) {
    if (row) deleteSchedule(id);
    return { ok: false, error: `Not created: the stored ${mismatch} differed from what the card showed, so it was removed again.` };
  }
  return { ok: true, schedule: row };
}
