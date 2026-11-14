/**
 * A session schedule lives and dies with its chat: it follows the chat when a provider renames it,
 * goes when the chat is deleted, and is refused for a chat that cannot take it or already has as
 * many as one chat may. The checks here are the server's own, shared by every door that saves one
 * (REST, CLI, the AI's tool), so none of them can save a schedule another would refuse.
 */
import { chatLifecycle, type ChatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { sessionIdAliases } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import {
  clearSessionSchedulePaused, clearSessionSchedulePending, countSessionSchedules, deleteSessionSchedulesForTarget,
  getSchedule, retargetSessionSchedules,
} from "../scheduler-db.service.ts";
import { nextFireAt } from "../scheduler-timing.ts";
import { MAX_SCHEDULES_PER_SESSION } from "../../shared/session-schedule-input.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { liveScheduleTargetDeps, resolveScheduleTarget, type ScheduleTarget, type ScheduleTargetDeps } from "./session-schedule-target.ts";

const log = createLogger("scheduler");

/** Why a session schedule cannot be saved or turned back on; `message` is for the user. */
export class SessionScheduleRefusal extends Error {
  constructor(readonly code: "invalid_target" | "limit" | "not_found", message: string) {
    super(message);
    this.name = "SessionScheduleRefusal";
  }
}

/** Every id the chat was known by, its current one first. */
function idsOf(sessionId: string, deps: Pick<ScheduleTargetDeps, "canonical">): string[] {
  const canonical = deps.canonical(sessionId);
  let aliases: string[] = [];
  try { aliases = sessionIdAliases(canonical); } catch { /* no metadata: the ids given are all there is */ }
  return [...new Set([canonical, sessionId, ...aliases])];
}

/** How many session schedules aim at the chat under any id it had. */
function schedulesOf(sessionId: string, deps: Pick<ScheduleTargetDeps, "canonical">): number {
  return idsOf(sessionId, deps).reduce((n, id) => n + countSessionSchedules(id), 0);
}

/**
 * The chat a new session schedule would run in, checked: an ordinary chat of a registered project,
 * on a provider schedules reach, with fewer than {@link MAX_SCHEDULES_PER_SESSION} schedules. Throws
 * {@link SessionScheduleRefusal} otherwise. The id returned is the chat's current one: store that.
 */
export function assertCanAddSessionSchedule(sessionId: string, deps: ScheduleTargetDeps = liveScheduleTargetDeps): ScheduleTarget {
  const resolved = resolveScheduleTarget(sessionId, deps);
  if (!resolved.ok) throw new SessionScheduleRefusal("invalid_target", resolved.reason);
  if (schedulesOf(resolved.target.sessionId, deps) >= MAX_SCHEDULES_PER_SESSION) {
    throw new SessionScheduleRefusal("limit", `A chat may have at most ${MAX_SCHEDULES_PER_SESSION} schedules; delete one first.`);
  }
  return resolved.target;
}

/**
 * Turn a paused session schedule back on: its reason is cleared and its next fire counted from
 * `now`. Refused while its chat still cannot take it, since it would only pause again. The caller
 * re-arms the scheduler, as after any other edit.
 */
export function resumeSessionSchedule(id: number, now = new Date(), deps: ScheduleTargetDeps = liveScheduleTargetDeps): Schedule {
  const schedule = getSchedule(id);
  if (!schedule || schedule.kind !== "session") throw new SessionScheduleRefusal("not_found", "No session schedule with that id.");
  const resolved = resolveScheduleTarget(schedule.target_session_id ?? "", deps);
  if (!resolved.ok) throw new SessionScheduleRefusal("invalid_target", resolved.reason);
  if (resolved.target.sessionId !== schedule.target_session_id) retargetSessionSchedules(schedule.target_session_id!, resolved.target.sessionId);
  const next = schedule.recurring || schedule.next_fire_at !== null
    ? nextFireAt(schedule.cron_expr, schedule.timezone, now)
    // A one-shot whose single fire came due and was given up: it fires once, now, rather than at
    // the cron's next match, which for a date may be a year away.
    : now.toISOString();
  clearSessionSchedulePending(id);
  clearSessionSchedulePaused(id, next);
  log.info(`Schedule ${id} (${schedule.name}) turned back on; next fire ${next ?? "none"}`);
  return getSchedule(id)!;
}

/** The chat is gone: so are the schedules aimed at it, under any id it had. Answers how many. */
export function forgetSessionSchedulesOf(sessionId: string, deps: Pick<ScheduleTargetDeps, "canonical"> = liveScheduleTargetDeps): number {
  let removed = 0;
  for (const id of idsOf(sessionId, deps)) removed += deleteSessionSchedulesForTarget(id);
  if (removed > 0) log.info(`session=${sessionId} deleted, with its ${removed} schedule(s)`);
  return removed;
}

/** Follows chats a provider renames (Codex, during a new chat's first turn); returns the unsubscribe. */
export function followRenamedChats(lifecycle: ChatLifecycle = chatLifecycle): () => void {
  return lifecycle.on("migrated", ({ oldSessionId, newSessionId }) => {
    try {
      const moved = retargetSessionSchedules(oldSessionId, newSessionId);
      if (moved > 0) log.info(`session=${oldSessionId} renamed to ${newSessionId}: ${moved} schedule(s) follow it`);
    } catch (e) {
      log.warn(`session=${oldSessionId} schedules could not follow the rename to ${newSessionId}: ${(e as Error).message}`);
    }
  });
}
