/**
 * The deliverer's view of the running server: the chat door, the chat events, the notification
 * service. Kept apart from the deliverer's rules so those can be tested with no server at all.
 */
import { chatControl } from "../chat-control/chat-control.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { getSessionTitle, resolveMigratedSession } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import { neutralizePpmTags } from "../assistant-watch/watch-event-text.ts";
import { resolveSessionDir } from "../subagent-transcript-merger.ts";
import type { ScheduleNotice, SessionScheduleDispatchEnv } from "./session-schedule-dispatch-types.ts";
import { liveScheduleTargetDeps, resolveScheduleTarget, type ScheduleTargetResolution } from "./session-schedule-target.ts";

const log = createLogger("scheduler");

/** A chat that said "busy" with nothing announced to wake on is asked again after this. */
const RETRY_DELAY_MS = 30_000;
/** How often a schedule message in flight is checked against the chat's live state. */
const FLIGHT_CHECK_MS = 60_000;
/**
 * A message queued behind a turn opens its own as soon as that turn is over (the provider names
 * it within milliseconds); this long after, a chat that is idle and no longer holds it lost it.
 */
const QUEUED_CHECK_MS = 3_000;

/**
 * Sent on its own notification slot: news about a chat that must neither replace that chat's own
 * notification (its waiting approval) nor be replaced by it.
 */
function notifyScheduleNotice(n: ScheduleNotice): void {
  import("../notification.service.ts").then(({ notificationService }) => {
    void notificationService.broadcast("schedule", {
      title: n.title,
      body: n.body,
      project: n.projectName,
      sessionId: n.sessionId,
      ...(n.providerId ? { providerId: n.providerId } : {}),
    }, {
      ownKey: `session-schedule-${n.kind}:${n.schedule.id}`,
      ...(n.stillRelevant ? { stillUnseen: n.stillRelevant } : {}),
    });
  }).catch((e) => log.warn(`could not notify about schedule ${n.schedule.id}: ${(e as Error).message}`));
}

/**
 * The target as the deliverer may use it. A Claude chat whose conversation is gone from disk is
 * refused here: resumed, the provider would start it fresh under the same id, which is a new chat
 * in all but name, and a schedule never creates one.
 */
function deliveryTarget(sessionId: string): ScheduleTargetResolution {
  const resolved = resolveScheduleTarget(sessionId);
  if (!resolved.ok || resolved.target.providerId !== "claude") return resolved;
  const { target } = resolved;
  if (resolveSessionDir(target.sessionId, target.projectPath) === null) {
    return { ok: false, reason: "The chat's conversation is no longer on this machine." };
  }
  return resolved;
}

export function liveDispatchEnv(): SessionScheduleDispatchEnv {
  return {
    control: chatControl,
    lifecycle: chatLifecycle,
    now: () => Date.now(),
    canonical: resolveMigratedSession,
    target: deliveryTarget,
    notify: notifyScheduleNotice,
    chatTitle: (sessionId) => liveScheduleTargetDeps.stored(sessionId, getSessionTitle) ?? `Session ${sessionId.slice(0, 8)}`,
    newClientMessageId: () => `schedule-${crypto.randomUUID()}`,
    // The prompt may have been written by an AI through the schedule tools: it may not pose as PPM.
    promptText: neutralizePpmTags,
    retryDelayMs: RETRY_DELAY_MS,
    flightCheckMs: FLIGHT_CHECK_MS,
    queuedCheckMs: QUEUED_CHECK_MS,
  };
}
