/**
 * What happens to a session schedule that cannot go out now, apart from the deliverer's own flow:
 * held up behind a card (the user told once per pending period), failed for a reason that may
 * pass (the chat tried again after a growing wait, then its schedules paused together), or aimed at
 * a chat PPM can no longer reach (every waiting schedule of that chat paused, with one notice for
 * all of them).
 */
import { createLogger } from "../logger.ts";
import type { Schedule } from "../../types/scheduler.ts";
import type { NoticeChat, SessionScheduleDispatchEnv } from "./session-schedule-dispatch-types.ts";
import { failedPartwayNotice, heldUpNotice, pausedNotice, retryingNotice } from "./session-schedule-notices.ts";
import { describeWait, ScheduleRetryBackoff } from "./session-schedule-retry-backoff.ts";
import { pauseSessionSchedule } from "./session-schedule-run-records.ts";
import type { SessionScheduleWaitingList } from "./session-schedule-waiting-list.ts";
import { broadcastSchedulesChanged } from "./session-schedules-changed.ts";

const log = createLogger("scheduler");

export class SessionScheduleSetbacks {
  /** `<schedule id>@<pending since>`: the pending periods the user was already told were held up. */
  private readonly told = new Set<string>();
  private readonly backoff: ScheduleRetryBackoff;

  /** `retry` sends into a chat again once its wait is over. */
  constructor(
    private readonly env: SessionScheduleDispatchEnv,
    private readonly waiting: SessionScheduleWaitingList,
    private readonly retry: (sessionId: string) => void,
  ) {
    this.backoff = new ScheduleRetryBackoff(env.retryBackoffMs, () => env.now());
  }

  /** The chat waits out a backoff: none of its schedules is sent before the wait is over. */
  isBackingOff(sessionId: string): boolean {
    return this.backoff.isWaiting(sessionId);
  }

  /** When the backing-off chat is tried again (epoch ms), or null. */
  retryAt(sessionId: string): number | null {
    return this.backoff.retryAt(sessionId);
  }

  /** The provider renamed the chat: its failure count and wait follow it. */
  rename(oldId: string, newId: string): void {
    this.backoff.rename(oldId, newId);
  }

  /** Its turn opened: a later hold-up is news again. */
  turnOpened(scheduleId: number): void {
    for (const key of [...this.told]) if (key.startsWith(`${scheduleId}@`)) this.told.delete(key);
  }

  /** The chat took a schedule's turn and ran it: its next failure counts from one. */
  succeeded(sessionId: string): void {
    this.backoff.succeeded(sessionId);
  }

  /** Once per pending period: the schedule waits behind a card the user has to answer first. */
  heldUp(schedule: Schedule, chat: NoticeChat): void {
    const key = `${schedule.id}@${schedule.pending_since}`;
    if (this.told.has(key)) return;
    this.told.add(key);
    const { control } = this.env;
    const { sessionId } = chat;
    this.env.notify(heldUpNotice(schedule, chat, this.env.chatTitle(sessionId), () => {
      const live = control()?.liveState(sessionId);
      return !!live && (!!live.card || live.queuedCards > 0);
    }));
  }

  /**
   * A failure that may pass. The fire stays pending and the chat is tried again after a wait that
   * grows with each failure in a row; every schedule pending for it waits as well. Once the waits
   * are spent, all of the chat's pending schedules pause together, with one notice naming them.
   * `tellFirst`: a turn failed, so the user hears about the first failure as well.
   */
  failed(sessionId: string, schedule: Schedule, chat: NoticeChat, reason: string, tellFirst: boolean): void {
    // Still waiting: it goes again first when the chat's wait is over, or pauses with the others.
    this.waiting.add(sessionId, schedule.id);
    const outcome = this.backoff.fail(sessionId, () => this.retry(sessionId));
    if (outcome.verdict === "give_up") {
      const why = `${reason} Schedules in this chat failed ${outcome.failures} times in a row.`;
      const paused = this.waiting.takeAll(sessionId);
      for (const s of paused) pauseSessionSchedule(s, why);
      if (paused.length > 0) this.env.notify(pausedNotice(paused, chat, why));
    } else {
      log.warn(`session=${sessionId} schedule ${schedule.id} (${schedule.name}) failure ${outcome.failures} in a row: ${reason} Trying the chat again in ${describeWait(outcome.delayMs)}`);
      if (tellFirst && outcome.failures === 1) this.env.notify(retryingNotice(schedule, chat, reason, outcome.delayMs));
    }
    broadcastSchedulesChanged();
  }

  /**
   * Its turn failed after it had already done something visible. Sending the prompt again would
   * redo whatever its tools did, so it is not retried: a one-shot is paused (its fire given up), a
   * recurring one waits for its next fire. The chat itself took the turn, so its failure count
   * starts again from one.
   */
  failedPartway(sessionId: string, schedule: Schedule, chat: NoticeChat, why: string): void {
    this.backoff.succeeded(sessionId);
    if (!schedule.recurring) pauseSessionSchedule(schedule, `The scheduled turn failed partway (${why}); resume it to try again.`);
    else log.warn(`Schedule ${schedule.id} (${schedule.name}) failed partway: ${why}. Not sent again; it waits for its next fire`);
    this.env.notify(failedPartwayNotice(schedule, chat, why));
    broadcastSchedulesChanged();
  }

  /**
   * The chat cannot be reached any more: every schedule waiting for it pauses, with one notice
   * naming them all (a chat deleted while PPM was off can hold many pending fires).
   */
  pauseAll(sessionId: string, reason: string): void {
    const paused = this.waiting.takeAll(sessionId);
    this.backoff.succeeded(sessionId);
    for (const schedule of paused) pauseSessionSchedule(schedule, reason);
    if (paused.length === 0) return;
    this.env.notify(pausedNotice(paused, { sessionId, projectName: "" }, reason));
    broadcastSchedulesChanged();
  }

  clear(): void {
    this.backoff.clear();
    this.told.clear();
  }
}
