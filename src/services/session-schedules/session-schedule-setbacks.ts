/**
 * What happens to a session schedule that cannot go out now, apart from the deliverer's own flow:
 * held up behind a card (the user told once per pending period), failed for a reason that may
 * pass (tried again after a growing wait, then paused), or aimed at a chat PPM can no longer reach
 * (every waiting schedule of that chat paused, with one notice for all of them).
 */
import { createLogger } from "../logger.ts";
import type { Schedule } from "../../types/scheduler.ts";
import type { NoticeChat, SessionScheduleDispatchEnv } from "./session-schedule-dispatch-types.ts";
import { heldUpNotice, pausedNotice, retryingNotice } from "./session-schedule-notices.ts";
import { describeWait, ScheduleRetryBackoff } from "./session-schedule-retry-backoff.ts";
import { pauseSessionSchedule } from "./session-schedule-run-records.ts";
import type { SessionScheduleWaitingList } from "./session-schedule-waiting-list.ts";
import { broadcastSchedulesChanged } from "./session-schedules-changed.ts";

const log = createLogger("scheduler");

export class SessionScheduleSetbacks {
  /** `<schedule id>@<pending since>`: the pending periods the user was already told were held up. */
  private readonly told = new Set<string>();
  private readonly backoff: ScheduleRetryBackoff;

  /** `retry` sends a schedule again once its wait is over. */
  constructor(
    private readonly env: SessionScheduleDispatchEnv,
    private readonly waiting: SessionScheduleWaitingList,
    private readonly retry: (scheduleId: number) => void,
  ) {
    this.backoff = new ScheduleRetryBackoff(env.retryBackoffMs);
  }

  /** Waiting out a backoff: nothing sends it before its wait is over. */
  isBackingOff(scheduleId: number): boolean {
    return this.backoff.isWaiting(scheduleId);
  }

  /** Its turn opened: a later hold-up is news again. */
  turnOpened(scheduleId: number): void {
    for (const key of [...this.told]) if (key.startsWith(`${scheduleId}@`)) this.told.delete(key);
  }

  /** It went through: a later failure counts from one. */
  succeeded(scheduleId: number): void {
    this.backoff.succeeded(scheduleId);
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
   * A failure that may pass. The fire stays pending and the schedule is tried again after a wait
   * that grows with each failure in a row; once the waits are spent it is paused and the user told.
   * `tellFirst`: a one-shot's turn failed, so the user hears about the first failure as well.
   */
  failed(sessionId: string, schedule: Schedule, chat: NoticeChat, reason: string, tellFirst: boolean): void {
    this.waiting.drop(sessionId, schedule.id);
    const outcome = this.backoff.fail(schedule.id, () => this.retry(schedule.id));
    if (outcome.verdict === "give_up") {
      const why = `${reason} It failed ${outcome.failures} times in a row.`;
      pauseSessionSchedule(schedule, why);
      this.env.notify(pausedNotice([schedule], chat, why));
    } else {
      log.warn(`Schedule ${schedule.id} (${schedule.name}) failure ${outcome.failures}: ${reason} Trying again in ${describeWait(outcome.delayMs)}`);
      if (tellFirst && outcome.failures === 1) this.env.notify(retryingNotice(schedule, chat, reason, outcome.delayMs));
    }
    broadcastSchedulesChanged();
  }

  /**
   * The chat cannot be reached any more: every schedule waiting for it pauses, with one notice
   * naming them all (a chat deleted while PPM was off can hold many pending fires).
   */
  pauseAll(sessionId: string, reason: string): void {
    const paused = this.waiting.takeAll(sessionId);
    for (const schedule of paused) {
      pauseSessionSchedule(schedule, reason);
      this.backoff.succeeded(schedule.id);
    }
    if (paused.length === 0) return;
    this.env.notify(pausedNotice(paused, { sessionId, projectName: "" }, reason));
    broadcastSchedulesChanged();
  }

  clear(): void {
    this.backoff.clear();
    this.told.clear();
  }
}
