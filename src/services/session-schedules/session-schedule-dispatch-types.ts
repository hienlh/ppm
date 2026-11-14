/**
 * The shapes the session-schedule deliverer works with, kept apart from its rules so the live
 * environment (`session-schedule-dispatch-env.ts`) and the tests can build one without loading
 * the deliverer, and the deliverer stays one readable file.
 */
import { CHAT_BUSY, type ChatControl, type LiveChatState } from "../chat-control/chat-control.ts";
import type { ChatLifecycle, ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import type { Schedule } from "../../types/scheduler.ts";
import type { ScheduleTargetResolution } from "./session-schedule-target.ts";

/** The chat a notice is about, as a notification links back to it. */
export interface NoticeChat {
  sessionId: string;
  projectName: string;
  providerId?: string;
}

/** Something the user should hear about schedules, through the ordinary notification service. */
export interface ScheduleNotice extends NoticeChat {
  kind: "waiting" | "paused" | "retrying";
  /** The notification slot it takes: a later notice with the same key replaces it. */
  key: string;
  /** The schedules it is about; a chat that cannot be reached pauses all of its at once. */
  schedules: Schedule[];
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
  /**
   * How often a message in flight is checked against the chat's live state, so a turn end PPM
   * never heard (or a queued message that vanished) cannot hold the chat's schedules forever.
   */
  flightCheckMs: number;
  /** After the turn a message was queued behind ended: how long its own turn has to open. */
  queuedCheckMs: number;
  /** Waits before trying again after the 1st, 2nd… failure in a row; past the last, it pauses. */
  retryBackoffMs: readonly number[];
}

/** A schedule's turn on its way into a chat, or running there. */
export interface Flight {
  schedule: Schedule;
  /** The chat it goes to, for the notices its outcome may need. */
  chat: NoticeChat;
  clientMessageId: string;
  /** `sending`: handed to the chat; `queued`: behind a turn that started meanwhile; `started`: its own turn runs. */
  phase: "sending" | "queued" | "started";
  runId: number | null;
  /** The provider named the turn this message opened (`turn_started` with its id). */
  opened?: true;
  /** A turn end heard while still sending. */
  earlyEnd?: ChatLifecycleEvents["turn_ended"];
  /** The next look at the chat's live state while queued or started. */
  check?: ReturnType<typeof setTimeout>;
  /** Looks in a row that found the chat idle while this message was still said to be queued. */
  idleChecks: number;
}

/** The chat runs no turn and shows or holds no card. */
export const chatIsIdle = (live: LiveChatState | null): boolean =>
  !live || (!live.running && !live.card && live.queuedCards === 0);

/** Errors that mean "not now" rather than "never": the chat is starting, closing or busy. */
const TRANSIENT = [CHAT_BUSY, "still starting", "closed before it could take"];

export const isTransientDeliveryError = (error: string): boolean =>
  TRANSIENT.some((t) => error === t || error.includes(t));

/** A session schedule that is on, not paused, and has a fire waiting. */
export function deliverable(schedule: Schedule | null): schedule is Schedule {
  return !!schedule && schedule.kind === "session" && !!schedule.enabled && !schedule.paused_reason
    && !!schedule.pending_since && !!schedule.target_session_id;
}
