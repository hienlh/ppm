/**
 * Sends a session schedule's pending fire into its chat, as a turn of its own, once that chat is
 * idle: no turn running, no card on screen or waiting behind it. A busy chat is waited out on the
 * chat's own events (`turn_ended`, `approval_resolved`), never polled. One schedule turn per chat
 * at a time; several schedules pending for one chat go one turn after another.
 *
 * A scheduled turn is an ordinary turn in the chat's own permission mode: its approvals are shown
 * and wait for the user, and the user is told when a schedule is held up by a card already
 * waiting. A chat PPM can no longer reach pauses its schedules instead; no chat is ever created.
 */
import type { ChatControl } from "../chat-control/chat-control.ts";
import type { ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { createLogger } from "../logger.ts";
import { getSchedule, retargetSessionSchedules } from "../scheduler-db.service.ts";
import type { Schedule } from "../../types/scheduler.ts";
import {
  chatIsIdle, deliverable, isTransientDeliveryError, type Flight, type NoticeChat, type SessionScheduleDispatchEnv,
} from "./session-schedule-dispatch-types.ts";
import { heldUpNotice, pausedNotice, retryingNotice } from "./session-schedule-notices.ts";
import { describeWait, ScheduleRetryBackoff } from "./session-schedule-retry-backoff.ts";
import { scheduleRunReference } from "./session-schedule-run-reference.ts";
import {
  pauseSessionSchedule, recordOneShotDelivered, recordRunEnded, recordRunStarted, turnFailed,
} from "./session-schedule-run-records.ts";
import { SessionScheduleWaitingList } from "./session-schedule-waiting-list.ts";

export type { ScheduleNotice, SessionScheduleDispatchEnv } from "./session-schedule-dispatch-types.ts";

const log = createLogger("scheduler");

/** Idle looks a message still said to be queued survives before it is taken as lost and sent again. */
const QUEUED_IDLE_CHECKS = 3;

export class SessionScheduleDispatcher {
  private readonly waiting = new SessionScheduleWaitingList();
  private readonly flights = new Map<string, Flight>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** `<schedule id>@<pending since>`: the pending periods the user was already told were held up. */
  private readonly told = new Set<string>();
  /** Consecutive failures per schedule, and the wait before each is tried again. */
  private readonly backoff: ScheduleRetryBackoff;
  private stops: Array<() => void> = [];

  constructor(private readonly env: SessionScheduleDispatchEnv) {
    this.backoff = new ScheduleRetryBackoff(env.retryBackoffMs);
  }

  get running(): boolean { return this.stops.length > 0; }

  start(): void {
    if (this.running) return;
    const { lifecycle } = this.env;
    this.stops = [
      lifecycle.on("turn_ended", (p) => this.onTurnEnded(p)),
      lifecycle.on("approval_resolved", (p) => this.wake(p.sessionId)),
      lifecycle.on("stream", (p) => this.onStream(p)),
      lifecycle.on("migrated", (p) => this.onMigrated(p.oldSessionId, p.newSessionId)),
    ];
  }

  stop(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    this.backoff.clear();
    this.waiting.clear();
    for (const flight of this.flights.values()) if (flight.check) clearTimeout(flight.check);
    this.flights.clear();
  }

  /** The scheduler says this schedule has a fire waiting to be delivered. */
  due(scheduleId: number): Promise<void> {
    const schedule = getSchedule(scheduleId);
    if (!this.running || !deliverable(schedule)) return Promise.resolve();
    // Failed a moment ago: its backoff timer hands it back, and fires meanwhile fold into it.
    if (this.backoff.isWaiting(scheduleId)) return Promise.resolve();
    const sessionId = this.env.canonical(schedule.target_session_id!);
    // A chat renamed while PPM was not listening: the schedules follow it now.
    if (sessionId !== schedule.target_session_id) retargetSessionSchedules(schedule.target_session_id!, sessionId);
    this.waiting.add(sessionId, scheduleId);
    return this.pump(sessionId);
  }

  /** Sends the oldest pending schedule of this chat, if the chat is idle and nothing is in flight. */
  async pump(asked: string): Promise<void> {
    const sessionId = this.env.canonical(asked);
    if (!this.running || this.flights.has(sessionId)) return;
    const schedule = this.waiting.next(sessionId);
    if (!schedule) return;
    const resolved = this.env.target(sessionId);
    if (!resolved.ok) return this.pauseAll(sessionId, resolved.reason);
    const { target } = resolved;
    const control = this.env.control();
    // The chat layer loads after the scheduler hands over pending fires: look again shortly.
    if (!control) return this.retryLater(sessionId);
    const chat: NoticeChat = { sessionId: target.sessionId, projectName: target.projectName, providerId: target.providerId };
    const live = control.liveState(sessionId);
    if (live && (live.card || live.queuedCards > 0)) return this.tellHeldUp(schedule, chat);
    if (live?.running) return;

    const flight: Flight = { schedule, chat, clientMessageId: this.env.newClientMessageId(), phase: "sending", runId: null, idleChecks: 0 };
    this.flights.set(sessionId, flight);
    let result: Awaited<ReturnType<ChatControl["sendUserMessage"]>>;
    try {
      result = await control.sendUserMessage(sessionId, this.env.promptText(schedule.prompt), {
        origin: "schedule", projectName: target.projectName, providerId: target.providerId,
        clientMessageId: flight.clientMessageId, scheduleRun: scheduleRunReference(schedule, this.env.now()),
      });
    } catch (e) {
      result = { ok: false, error: (e as Error)?.message ?? String(e) };
    }
    const current = this.keyOf(flight) ?? sessionId;
    if (this.flights.get(current) !== flight) return; // stopped meanwhile
    if (!result.ok) {
      this.flights.delete(current);
      if (isTransientDeliveryError(result.error)) return this.retryLater(current);
      // Whether the chat is gone for good is the target's to say: deleted, its conversation gone
      // from disk, no longer a chat a schedule may reach. Any other refusal (the session would not
      // resume, the message could not be pushed) may pass, so it is tried again before pausing.
      const now = this.env.target(current);
      if (!now.ok) return this.pauseAll(current, now.reason);
      return this.failed(current, schedule, chat, `PPM could not send it into its chat: ${result.error}.`, false);
    }
    const early = flight.earlyEnd;
    flight.earlyEnd = undefined;
    if (result.delivered === undefined || result.delivered === "started") {
      this.begin(current, flight);
      if (early) this.end(current, flight, early);
      return;
    }
    // Queued behind a turn that began after the quiet check. Only the turn the provider names as
    // this message's own is its run: a turn ending says nothing, since Stop may have taken the
    // queued message down with the turn it waited behind.
    if (flight.opened) return this.begin(current, flight);
    flight.phase = "queued";
    this.watch(flight, early ? this.env.queuedCheckMs : this.env.flightCheckMs);
  }

  private onTurnEnded(p: ChatLifecycleEvents["turn_ended"]): void {
    // A builtin command answered mid-turn: the running turn, a scheduled one included, goes on.
    // Whether the chat is free is still judged from its live state when the next fire is pumped.
    if (p.turnStillRunning) return;
    const sessionId = this.env.canonical(p.sessionId);
    const flight = this.flights.get(sessionId);
    if (!flight) return this.wake(sessionId);
    if (flight.phase === "sending") flight.earlyEnd = p;
    // The turn this message waited behind is over: its own should open now, and is looked for.
    else if (flight.phase === "queued") this.watch(flight, this.env.queuedCheckMs);
    else this.end(sessionId, flight, p);
  }

  /** The provider names the turn a message opened (`turn_started`), which may come before any end. */
  private onStream(p: ChatLifecycleEvents["stream"]): void {
    if (this.flights.size === 0) return;
    const ev = p.event as { type?: unknown; clientMessageId?: unknown } | null;
    if (ev?.type !== "turn_started" || typeof ev.clientMessageId !== "string") return;
    const sessionId = this.env.canonical(p.sessionId);
    const flight = this.flights.get(sessionId);
    if (!flight || flight.clientMessageId !== ev.clientMessageId) return;
    flight.opened = true;
    if (flight.phase === "queued") this.begin(sessionId, flight);
  }

  /** Look at the chat's live state again after `ms`. */
  private watch(flight: Flight, ms: number): void {
    if (flight.check) clearTimeout(flight.check);
    flight.check = setTimeout(() => this.checkFlight(flight), ms);
    (flight.check as { unref?: () => void }).unref?.();
  }

  /**
   * The flight against the chat's live state. A started turn whose chat is idle ended without PPM
   * hearing it. A queued message the chat no longer holds, with no turn running, was lost (Stop
   * killed the provider with it still queued): its fire is still pending, so it is sent again.
   */
  private checkFlight(flight: Flight): void {
    const sessionId = this.keyOf(flight);
    if (!sessionId) return;
    flight.check = undefined;
    const control = this.env.control();
    const idle = chatIsIdle(control?.liveState(sessionId) ?? null);
    if (flight.phase === "started") {
      if (!idle) return this.watch(flight, this.env.flightCheckMs);
      log.warn(`session=${sessionId} schedule ${flight.schedule.id}: its turn ended unheard; the run is closed`);
      return this.end(sessionId, flight, {
        sessionId, outcome: "stopped", error: "PPM did not hear how this turn ended.", projectName: "", providerId: "",
      }, true);
    }
    if (flight.phase !== "queued") return;
    if (!idle) {
      flight.idleChecks = 0;
      return this.watch(flight, this.env.flightCheckMs);
    }
    const queued = control?.messageQueued?.(sessionId, flight.clientMessageId) ?? null;
    // A provider that cannot say, or one that still claims the message with nothing running to
    // hold it behind, is believed for a few looks only: an idle chat starts a queued message at once.
    if (queued !== false && ++flight.idleChecks < QUEUED_IDLE_CHECKS) return this.watch(flight, this.env.flightCheckMs);
    this.flights.delete(sessionId);
    log.info(`session=${sessionId} schedule ${flight.schedule.id}: its queued message was dropped before its turn opened; sending it again`);
    this.wakeSoon(sessionId);
  }

  private begin(sessionId: string, flight: Flight): void {
    flight.phase = "started";
    this.watch(flight, this.env.flightCheckMs);
    this.waiting.drop(sessionId, flight.schedule.id);
    for (const key of [...this.told]) if (key.startsWith(`${flight.schedule.id}@`)) this.told.delete(key);
    try {
      // Read again: the schedule may have been edited or deleted while its message went in.
      const schedule = getSchedule(flight.schedule.id);
      if (schedule) flight.runId = recordRunStarted(schedule, sessionId, this.env.now());
    } catch (e) {
      log.warn(`could not record the run of schedule ${flight.schedule.id}: ${(e as Error).message}`);
    }
    // A recurring fire is spent once its turn opens. A one-shot's counts only once its turn ran.
    if (flight.schedule.recurring) this.backoff.succeeded(flight.schedule.id);
  }

  /**
   * The schedule's turn is over. A one-shot goes only when that turn did not fail; one that failed
   * keeps its fire pending and is tried again. `unheard`: PPM closed the turn itself, having found
   * the chat idle with no end heard; the turn did open, so a one-shot counts as delivered.
   */
  private end(sessionId: string, flight: Flight, p: ChatLifecycleEvents["turn_ended"], unheard = false): void {
    if (flight.check) clearTimeout(flight.check);
    this.flights.delete(sessionId);
    if (flight.runId !== null) {
      try { recordRunEnded(flight.runId, p); } catch (e) {
        log.warn(`could not record the end of schedule ${flight.schedule.id}'s run: ${(e as Error).message}`);
      }
    }
    const schedule = flight.schedule.recurring ? null : getSchedule(flight.schedule.id);
    if (schedule) {
      if (!unheard && turnFailed(p)) {
        const why = p.error ?? p.stop?.message.split("\n")[0] ?? `the turn ${p.outcome}`;
        return this.failed(sessionId, schedule, flight.chat, `Its turn failed: ${String(why).replace(/\.$/, "")}.`, true);
      }
      try { recordOneShotDelivered(schedule, sessionId); } catch (e) {
        log.warn(`could not remove one-shot schedule ${schedule.id}: ${(e as Error).message}`);
      }
      this.backoff.succeeded(schedule.id);
    }
    this.wakeSoon(sessionId);
  }

  /**
   * A failure that may pass. The fire stays pending and the schedule is tried again after a wait
   * that grows with each failure in a row; once the waits are spent it is paused and the user told.
   * `tellFirst`: a one-shot's turn failed, so the user hears about the first failure as well.
   */
  private failed(sessionId: string, schedule: Schedule, chat: NoticeChat, reason: string, tellFirst: boolean): void {
    this.waiting.drop(sessionId, schedule.id);
    const outcome = this.backoff.fail(schedule.id, () => {
      this.due(schedule.id).catch((e) => log.warn(`schedule ${schedule.id} retry failed: ${(e as Error).message}`));
    });
    if (outcome.verdict === "give_up") {
      const why = `${reason} It failed ${outcome.failures} times in a row.`;
      pauseSessionSchedule(schedule, why);
      this.env.notify(pausedNotice([schedule], chat, why));
    } else {
      log.warn(`Schedule ${schedule.id} (${schedule.name}) failure ${outcome.failures}: ${reason} Trying again in ${describeWait(outcome.delayMs)}`);
      if (tellFirst && outcome.failures === 1) this.env.notify(retryingNotice(schedule, chat, reason, outcome.delayMs));
    }
    this.wakeSoon(sessionId);
  }

  private pauseAll(sessionId: string, reason: string): void {
    for (const schedule of this.waiting.takeAll(sessionId)) {
      pauseSessionSchedule(schedule, reason);
      this.backoff.succeeded(schedule.id);
      this.env.notify(pausedNotice([schedule], { sessionId, projectName: "" }, reason));
    }
  }

  /** Once per pending period: the schedule waits behind a card the user has to answer first. */
  private tellHeldUp(schedule: Schedule, chat: NoticeChat): void {
    const key = `${schedule.id}@${schedule.pending_since}`;
    if (this.told.has(key)) return;
    this.told.add(key);
    const control = this.env.control;
    const { sessionId } = chat;
    this.env.notify(heldUpNotice(schedule, chat, this.env.chatTitle(sessionId), () => {
      const live = control()?.liveState(sessionId);
      return !!live && (!!live.card || live.queuedCards > 0);
    }));
  }

  /** A chat event that may have freed the chat: look again once the event has played out. */
  private wake(asked: string): void {
    const sessionId = this.env.canonical(asked);
    if (this.waiting.has(sessionId)) this.wakeSoon(sessionId);
  }

  private wakeSoon(sessionId: string): void {
    if (!this.waiting.has(sessionId)) return;
    setTimeout(() => { this.pump(sessionId).catch((e) => log.warn(`session=${sessionId} schedule delivery failed: ${(e as Error).message}`)); }, 0);
  }

  /** Busy with nothing announced to wake on (a message on its way in): one look later. */
  private retryLater(sessionId: string): void {
    if (this.retries.has(sessionId)) return;
    const timer = setTimeout(() => { this.retries.delete(sessionId); this.wakeSoon(sessionId); }, this.env.retryDelayMs);
    (timer as { unref?: () => void }).unref?.();
    this.retries.set(sessionId, timer);
  }

  private keyOf(flight: Flight): string | null {
    for (const [key, f] of this.flights) if (f === flight) return key;
    return null;
  }

  private onMigrated(oldId: string, newId: string): void {
    this.waiting.rename(oldId, newId);
    for (const map of [this.flights, this.retries] as Array<Map<string, unknown>>) {
      if (!map.has(oldId)) continue;
      map.set(newId, map.get(oldId));
      map.delete(oldId);
    }
  }
}
