/**
 * `session_schedule_create`, `session_schedule_list`, `session_schedule_delete`: the AI schedules
 * prompts into its own chat. The chat is the one the token names, resolved to its current id and
 * never taken from the arguments, so a chat can neither see nor touch another chat's schedules.
 * Saving goes through the same function as the REST route and the CLI (`session-schedule-save.ts`).
 */
import { createLogger } from "../logger.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import type { BroadcastOutcome, NotificationPayload } from "../notification.service.ts";
import { MAX_SCHEDULES_PER_SESSION } from "../../shared/session-schedule-input.ts";
import {
  SESSION_SCHEDULE_CREATE_TOOL, SESSION_SCHEDULE_DELETE_TOOL, SESSION_SCHEDULE_LIST_TOOL, type SessionScheduleTool,
} from "../../shared/session-schedule-tools.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { deleteSchedule, getSchedule, getSchedules } from "../scheduler-db.service.ts";
import { projectOfFolder } from "../assistant-mcp/assistant-schedule-shape.ts";
import { ScheduleEditError } from "../scheduler-edit.ts";
import { SessionScheduleRefusal, sessionScheduleTargetIds } from "../session-schedules/session-schedule-lifecycle.ts";
import { createSessionSchedule, sessionSchedulesOf } from "../session-schedules/session-schedule-save.ts";
import { announceSchedulesChanged } from "../session-schedules/session-schedules-changed.ts";
import { isSessionScheduleHeld } from "../session-schedules/session-schedule-due.ts";
import {
  liveScheduleTargetDeps, resolveScheduleTarget, storedChatTitle, type ScheduleTarget, type ScheduleTargetDeps,
} from "../session-schedules/session-schedule-target.ts";
import { aiCreatedScheduleNotice, aiSchedulesMutedNotice, wallClock } from "./collab-schedule-created-notice.ts";
import { AI_SCHEDULE_NOTICES_PER_HOUR, AiScheduleNoticeLimit } from "./collab-schedule-notice-limit.ts";

const log = createLogger("session-collab");

export interface SessionScheduleToolEnv {
  target: ScheduleTargetDeps;
  /** A schedule was added or removed: re-arm the scheduler and refresh open schedule lists. */
  changed(): void;
  now(): Date;
  /** The machine's own zone, which a schedule with none is read in. */
  localZone(): string;
  /** The chat's title as the user knows it. */
  chatTitle(sessionId: string): string;
  /**
   * Tell the user about the AI's schedules (`schedule_created`, through the notification service
   * and the user's own settings). Never throws into the tool: the schedule is saved either way.
   */
  notify(notice: AiScheduleNotice): void;
  /** How many of those notices each chat may still send (see `collab-schedule-notice-limit.ts`). */
  noticeLimit: AiScheduleNoticeLimit;
}

/** One notification about the AI's schedules. */
export interface AiScheduleNotice {
  payload: NotificationPayload;
  /** Its own notification slot and device tag (see `BroadcastOptions.ownKey`). */
  key: string;
  /** Asked when the notification delay ends; false sends nothing. */
  stillRelevant?: () => boolean;
}

/**
 * Sends `notice` through the notification service. A slot of its own: neither replaced by the chat's
 * "Chat completed" nor replacing it, and two schedules created in one turn are two notifications.
 */
export function sendAiScheduleNotice(notice: AiScheduleNotice): Promise<BroadcastOutcome | "failed"> {
  return import("../notification.service.ts")
    .then(({ notificationService }) => notificationService.broadcast("schedule_created", notice.payload, {
      ownKey: notice.key,
      ...(notice.stillRelevant ? { stillUnseen: notice.stillRelevant } : {}),
    }))
    .catch((e) => {
      log.warn(`could not send notice ${notice.key}: ${(e as Error).message}`);
      return "failed" as const;
    });
}

export const liveSessionScheduleToolEnv: SessionScheduleToolEnv = {
  target: liveScheduleTargetDeps,
  changed: announceSchedulesChanged,
  now: () => new Date(),
  localZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  chatTitle: storedChatTitle,
  notify: sendAiScheduleNotice,
  noticeLimit: new AiScheduleNoticeLimit(),
};

const json = (value: unknown, isError = false): Json => textResult(JSON.stringify(value, null, 1), isError);
const fail = (message: string): Json => textResult(message, true);

/** A schedule as the AI reads it, its times on the schedule's own wall clock. */
function describe(s: Schedule, env: SessionScheduleToolEnv): Json {
  const zone = s.timezone ?? env.localZone();
  const repeats = s.recurring === 1;
  return {
    id: s.id,
    name: s.name,
    prompt: s.prompt,
    cron: s.cron_expr,
    timeZone: zone,
    ...(s.timezone === null && { timeZoneIsMachineLocal: true }),
    recurring: repeats,
    schedule: repeats
      ? `Every match of "${s.cron_expr}" (minute hour day-of-month month day-of-week) in ${zone}, until deleted.`
      : `Once, at the next match of "${s.cron_expr}" in ${zone}; then it deletes itself.`,
    enabled: s.enabled === 1,
    nextFire: s.next_fire_at ? { at: s.next_fire_at, local: wallClock(s.next_fire_at, zone) } : null,
    ...(s.pending_since && {
      waitingSince: s.pending_since,
      waiting: isSessionScheduleHeld(s.id)
        ? "It came due and is held after Stop: the user stopped a turn in this chat, so it goes once this chat's next turn ends or its next fire comes due."
        : "It came due and is delivered once this chat is idle.",
    }),
    ...(s.paused_reason && { pausedReason: s.paused_reason }),
    ...(s.task_id && { taskId: s.task_id, taskNote: "It belongs to that task and is deleted when the task is closed." }),
  };
}

/**
 * A script or prompt schedule of the chat's project, as the list gives it: enough to pause or turn
 * it on by id, not its script or prompt (Settings → Schedules shows those).
 */
function describeProjectSchedule(s: Schedule, env: SessionScheduleToolEnv): Json {
  const zone = s.timezone ?? env.localZone();
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    mode: s.mode,
    ...(s.mode === "tick" ? { cron: s.cron_expr, timeZone: zone } : {}),
    enabled: s.enabled === 1,
    nextFire: s.enabled && s.next_fire_at ? { at: s.next_fire_at, local: wallClock(s.next_fire_at, zone) } : null,
    ...(s.description && { description: s.description.slice(0, 300) }),
  };
}

/**
 * The notice for a schedule the AI just created, within the chat's cap. It is sent only if the
 * schedule still exists when the notification delay ends, so a schedule created and deleted again
 * (or a one-shot that already ran) is not announced.
 */
function notifyAboutCreated(env: SessionScheduleToolEnv, created: Schedule, chat: ScheduleTarget): void {
  const turn = env.noticeLimit.take(chat.sessionId, env.now().getTime());
  if (turn.kind === "drop") {
    log.info(`not notifying about schedule ${created.id}: chat ${chat.sessionId} is past ${AI_SCHEDULE_NOTICES_PER_HOUR} schedule notices this hour`);
    return;
  }
  const title = env.chatTitle(chat.sessionId);
  if (turn.kind === "muted") {
    env.notify({
      payload: aiSchedulesMutedNotice(chat, title, AI_SCHEDULE_NOTICES_PER_HOUR, turn.resumesAt, env.localZone()),
      key: `session-schedules-muted-${chat.sessionId}`,
    });
    return;
  }
  env.notify({
    payload: aiCreatedScheduleNotice(created, chat, title, env.localZone()),
    key: `session-schedule-created-${created.id}`,
    stillRelevant: () => getSchedule(created.id) !== null,
  });
}

function refusalText(e: unknown): string {
  if (e instanceof ScheduleEditError) return `Not saved: ${e.problems.join("; ")}.`;
  if (e instanceof SessionScheduleRefusal) return `Not saved: ${e.message}`;
  return `Not saved: ${(e as Error).message}`;
}

export function sessionScheduleToolCall(env: SessionScheduleToolEnv, tokenSessionId: string, name: SessionScheduleTool, rawArgs: unknown): Json {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
  const chat = resolveScheduleTarget(tokenSessionId, env.target);
  if (!chat.ok) return fail(`This chat cannot have scheduled prompts: ${chat.reason}`);
  const sessionId = chat.target.sessionId;

  if (name === SESSION_SCHEDULE_CREATE_TOOL) {
    let created: Schedule;
    try {
      created = createSessionSchedule({
        target_session_id: sessionId, created_by_session_id: sessionId, cron_expr: args.cron, prompt: args.prompt, recurring: args.recurring,
        timezone: args.timezone, name: args.name, ...(args.task !== undefined && { task: args.task }),
      }, { deps: env.target, now: env.now() });
    } catch (e) {
      return fail(refusalText(e));
    }
    env.changed();
    // The AI needs no approval to schedule, so the user hears about the schedules it makes.
    try {
      notifyAboutCreated(env, created, chat.target);
    } catch (e) {
      log.warn(`could not tell the user about schedule ${created.id}: ${(e as Error).message}`);
    }
    return json({
      created: true,
      ...describe(created, env),
      note: "PPM stores this schedule: it survives restarts of PPM and of this chat. At each fire the prompt arrives in "
        + "this chat as a message, once the chat is idle. Delete it with session_schedule_delete and this id.",
    });
  }

  if (name === SESSION_SCHEDULE_LIST_TOOL) {
    const schedules = sessionSchedulesOf(sessionId, env.target);
    const project = [{ name: chat.target.projectName, path: chat.target.projectPath }];
    const projectSchedules = getSchedules()
      .filter((s) => s.kind !== "session" && projectOfFolder(s.project_path, project))
      .map((s) => describeProjectSchedule(s, env));
    return json({ schedules: schedules.map((s) => describe(s, env)), count: schedules.length, max: MAX_SCHEDULES_PER_SESSION, projectSchedules });
  }

  // The other schedule tools wait on a card and are served by `collab-schedule-proposals.ts`.
  if (name !== SESSION_SCHEDULE_DELETE_TOOL) return fail(`${name} is not served here.`);
  const id = typeof args.id === "number" ? args.id : typeof args.id === "string" && /^\d+$/.test(args.id) ? Number(args.id) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) return fail("`id` must be a schedule id from session_schedule_list.");
  const schedule = getSchedule(id);
  // Another chat's schedule reads exactly like one that does not exist: its id says nothing here.
  const own = schedule?.kind === "session" && sessionScheduleTargetIds(sessionId, env.target).includes(schedule.target_session_id ?? "");
  if (!schedule || !own) return fail(`This chat has no schedule with id ${id}; see session_schedule_list.`);
  deleteSchedule(id);
  env.changed();
  return json({ deleted: true, id, name: schedule.name, note: "It will not fire again." });
}
