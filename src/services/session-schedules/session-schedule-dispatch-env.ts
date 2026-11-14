/**
 * The deliverer's view of the running server: the chat door, the chat events, the notification
 * service. Kept apart from the deliverer's rules so those can be tested with no server at all.
 */
import { chatControl } from "../chat-control/chat-control.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { getSessionTitle, resolveMigratedSession } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import { neutralizePpmTags } from "../assistant-watch/watch-event-text.ts";
import type { ScheduleNotice, SessionScheduleDispatchEnv } from "./session-schedule-dispatcher.ts";
import { liveScheduleTargetDeps, resolveScheduleTarget } from "./session-schedule-target.ts";

const log = createLogger("scheduler");

/** A chat that said "busy" with nothing announced to wake on is asked again after this. */
const RETRY_DELAY_MS = 30_000;

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

export function liveDispatchEnv(): SessionScheduleDispatchEnv {
  return {
    control: chatControl,
    lifecycle: chatLifecycle,
    now: () => Date.now(),
    canonical: resolveMigratedSession,
    target: (sessionId) => resolveScheduleTarget(sessionId),
    notify: notifyScheduleNotice,
    chatTitle: (sessionId) => liveScheduleTargetDeps.stored(sessionId, getSessionTitle) ?? `Session ${sessionId.slice(0, 8)}`,
    newClientMessageId: () => `schedule-${crypto.randomUUID()}`,
    // The prompt may have been written by an AI through the schedule tools: it may not pose as PPM.
    promptText: neutralizePpmTags,
    retryDelayMs: RETRY_DELAY_MS,
  };
}
