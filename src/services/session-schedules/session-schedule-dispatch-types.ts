/**
 * The shapes the session-schedule deliverer works with, kept apart from its rules so the live
 * environment (`session-schedule-dispatch-env.ts`) and the tests can build one without loading
 * the deliverer, and the deliverer stays one readable file.
 */
import { CHAT_BUSY, type ChatControl } from "../chat-control/chat-control.ts";
import type { ChatLifecycle, ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import type { Schedule } from "../../types/scheduler.ts";
import type { ScheduleTargetResolution } from "./session-schedule-target.ts";

/** Something the user should hear about a schedule, through the ordinary notification service. */
export interface ScheduleNotice {
  kind: "waiting" | "paused";
  schedule: Schedule;
  sessionId: string;
  projectName: string;
  providerId?: string;
  title: string;
  body: string;
  /** Asked when a delayed notification is due; false drops it (the card was answered meanwhile). */
  stillRelevant?: () => boolean;
}

/** Everything the deliverer needs from the running server; a fake one in tests. */
export interface SessionScheduleDispatchEnv {
  /** The chat door, or null while the chat layer is not loaded yet. */
  control(): ChatControl | null;
  lifecycle: ChatLifecycle;
  now(): number;
  canonical(sessionId: string): string;
  target(sessionId: string): ScheduleTargetResolution;
  notify(notice: ScheduleNotice): void;
  chatTitle(sessionId: string): string;
  newClientMessageId(): string;
  /** Prompt text as the chat may receive it (PPM's own tags defused). */
  promptText(prompt: string): string;
  /** How long a chat that said "busy" with no event to come back on is left before asking again. */
  retryDelayMs: number;
}

/** A schedule's turn on its way into a chat, or running there. */
export interface Flight {
  schedule: Schedule;
  clientMessageId: string;
  /** `sending`: handed to the chat; `queued`: behind a turn that started meanwhile; `started`: its own turn runs. */
  phase: "sending" | "queued" | "started";
  runId: number | null;
  /** A turn end heard while still sending. */
  earlyEnd?: ChatLifecycleEvents["turn_ended"];
}

/** Errors that mean "not now" rather than "never": the chat is starting, closing or busy. */
const TRANSIENT = [CHAT_BUSY, "still starting", "closed before it could take"];

export const isTransientDeliveryError = (error: string): boolean =>
  TRANSIENT.some((t) => error === t || error.includes(t));

/** A session schedule that is on, not paused, and has a fire waiting. */
export function deliverable(schedule: Schedule | null): schedule is Schedule {
  return !!schedule && schedule.kind === "session" && !!schedule.enabled && !schedule.paused_reason
    && !!schedule.pending_since && !!schedule.target_session_id;
}

/** The user's notice that a schedule waits behind a card already on the chat's screen. */
export function heldUpNotice(
  schedule: Schedule, sessionId: string, projectName: string, providerId: string, chatTitle: string,
  stillRelevant: () => boolean,
): ScheduleNotice {
  return {
    kind: "waiting", schedule, sessionId, projectName, providerId, stillRelevant,
    title: "Schedule is waiting",
    body: `Schedule ${schedule.name} is waiting: an approval is pending in ${chatTitle}`,
  };
}

/** The user's notice that a schedule stopped firing until it is turned back on. */
export function pausedNotice(
  schedule: Schedule, sessionId: string, projectName: string, providerId: string | undefined, reason: string,
): ScheduleNotice {
  return {
    kind: "paused", schedule, sessionId, projectName, ...(providerId ? { providerId } : {}),
    title: `Schedule paused: ${schedule.name}`,
    body: `${reason} Turn it back on once the chat can take it again.`,
  };
}
