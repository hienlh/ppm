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
