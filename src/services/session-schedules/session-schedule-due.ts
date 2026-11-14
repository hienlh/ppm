/**
 * The hand-off from the scheduler to whatever delivers session schedules. The scheduler only
 * records that a fire came due (`pending_since`); delivery waits for the chat to be idle, which is
 * not the scheduler's to know. Registered at runtime so the scheduler never imports the chat chain:
 * until something registers, a due schedule just stays pending, and is handed over again at the
 * next start.
 */
import { createLogger } from "../logger.ts";

/** Told a schedule id whose fire is pending. Called again for a schedule already pending. */
export type SessionScheduleDueHandler = (scheduleId: number) => void | Promise<void>;

const log = createLogger("scheduler");

let handler: SessionScheduleDueHandler | null = null;

/** Register the deliverer, or clear it with null. */
export function setSessionScheduleDueHandler(fn: SessionScheduleDueHandler | null): void {
  handler = fn;
}

/** When the deliverer tries this schedule's chat again after a failure (epoch ms), or null. */
export type SessionScheduleRetryLookup = (scheduleId: number) => number | null;

let retryLookup: SessionScheduleRetryLookup | null = null;

/** Register how to ask the deliverer about a chat's retry wait, or clear it with null. */
export function setSessionScheduleRetryLookup(fn: SessionScheduleRetryLookup | null): void {
  retryLookup = fn;
}

/** Whether the deliverer holds this schedule's pending fire after a Stop in its chat. */
export type SessionScheduleHeldLookup = (scheduleId: number) => boolean;

let heldLookup: SessionScheduleHeldLookup | null = null;

/** Register how to ask the deliverer whether a schedule is held after a Stop, or clear it with null. */
export function setSessionScheduleHeldLookup(fn: SessionScheduleHeldLookup | null): void {
  heldLookup = fn;
}

/**
 * A pending fire the deliverer holds because the user stopped a turn in its chat: it goes once that
 * chat's next turn ends or the schedule's next fire comes due. False with no deliverer running.
 */
export function isSessionScheduleHeld(scheduleId: number): boolean {
  try {
    return heldLookup?.(scheduleId) ?? false;
  } catch (e) {
    log.warn(`could not ask whether schedule ${scheduleId} is held: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

/**
 * Run now while the schedule's chat waits out a retry after a failed send: the deliverer would
 * only fold the fire into the one already waiting, so the request is answered with when that
 * retry goes instead of looking accepted and doing nothing.
 */
export class SessionScheduleRetryWaitError extends Error {
  constructor(readonly retryAt: number) {
    const at = new Date(retryAt).toLocaleTimeString("en-GB", { hour12: false });
    super(`Waiting to retry after a failed send into its chat; next attempt at ${at}.`);
  }
}

/** Throws {@link SessionScheduleRetryWaitError} while the schedule's chat waits out a retry. */
export function assertNotWaitingToRetry(scheduleId: number): void {
  let at: number | null = null;
  try {
    at = retryLookup?.(scheduleId) ?? null;
  } catch (e) {
    log.warn(`could not ask whether schedule ${scheduleId} waits to retry: ${(e as Error)?.message ?? e}`);
  }
  if (at !== null) throw new SessionScheduleRetryWaitError(at);
}

/** Tell the deliverer, if any. Never throws into the scheduler: a failure is logged. */
export function notifySessionScheduleDue(scheduleId: number): void {
  if (!handler) return;
  try {
    const result = handler(scheduleId);
    if (result instanceof Promise) {
      result.catch((e) => log.warn(`delivering session schedule ${scheduleId} failed: ${(e as Error)?.message ?? e}`));
    }
  } catch (e) {
    log.warn(`delivering session schedule ${scheduleId} failed: ${(e as Error)?.message ?? e}`);
  }
}
