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
import { CHAT_BUSY, type ChatControl } from "../chat-control/chat-control.ts";
import type { ChatLifecycle, ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { createLogger } from "../logger.ts";
import { getSchedule, retargetSessionSchedules } from "../scheduler-db.service.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { scheduleRunReference } from "./session-schedule-run-reference.ts";
import { pauseSessionSchedule, recordRunEnded, recordRunStarted } from "./session-schedule-run-records.ts";
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

export interface SessionScheduleDispatchEnv {
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
interface Flight {
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

const log = createLogger("scheduler");

export class SessionScheduleDispatcher {
  private readonly waiting = new Map<string, Set<number>>();
  private readonly flights = new Map<string, Flight>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** `<schedule id>@<pending since>`: the pending periods the user was already told were held up. */
  private readonly told = new Set<string>();
  private stops: Array<() => void> = [];

  constructor(private readonly env: SessionScheduleDispatchEnv) {}

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
    this.waiting.clear();
    this.flights.clear();
  }

  /** The scheduler says this schedule has a fire waiting to be delivered. */
  due(scheduleId: number): Promise<void> {
    const schedule = getSchedule(scheduleId);
    if (!this.running || !deliverable(schedule)) return Promise.resolve();
    const sessionId = this.env.canonical(schedule.target_session_id!);
    // A chat renamed while PPM was not listening: the schedules follow it now.
    if (sessionId !== schedule.target_session_id) retargetSessionSchedules(schedule.target_session_id!, sessionId);
    let set = this.waiting.get(sessionId);
    if (!set) this.waiting.set(sessionId, set = new Set());
    set.add(scheduleId);
    return this.pump(sessionId);
  }

  /** Sends the oldest pending schedule of this chat, if the chat is idle and nothing is in flight. */
  async pump(asked: string): Promise<void> {
    const sessionId = this.env.canonical(asked);
    if (!this.running || this.flights.has(sessionId)) return;
    const schedule = this.nextWaiting(sessionId);
    if (!schedule) return;
    const resolved = this.env.target(sessionId);
    if (!resolved.ok) return this.pauseAll(sessionId, resolved.reason);
    const { target } = resolved;
    const control = this.env.control();
    if (!control) return; // no chat layer in this process: the fire stays pending for the next start
    const live = control.liveState(sessionId);
    if (live && (live.card || live.queuedCards > 0)) return this.tellHeldUp(schedule, target.sessionId, target.projectName, target.providerId);
    if (live?.running) return;

    const flight: Flight = { schedule, clientMessageId: this.env.newClientMessageId(), phase: "sending", runId: null };
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
      if (TRANSIENT.some((t) => result.error === t || result.error.includes(t))) return this.retryLater(current);
      pauseSessionSchedule(schedule, `PPM could not send it into its chat: ${result.error}`);
      this.dropWaiting(current, schedule.id);
      this.notifyPaused(schedule, target.sessionId, target.projectName, target.providerId, result.error);
      return this.wakeSoon(current);
    }
    const early = flight.earlyEnd;
    flight.earlyEnd = undefined;
    if (result.delivered === undefined || result.delivered === "started") {
      this.begin(current, flight);
      if (early) this.end(current, flight, early);
    } else if (early) {
      // A turn that started after the quiet check ended already: this message opened the next one.
      this.begin(current, flight);
    } else {
      flight.phase = "queued";
    }
  }

  private onTurnEnded(p: ChatLifecycleEvents["turn_ended"]): void {
    const sessionId = this.env.canonical(p.sessionId);
    const flight = this.flights.get(sessionId);
    if (!flight) return this.wake(sessionId);
    if (flight.phase === "sending") flight.earlyEnd = p;
    // The turn this message was queued behind is over; its own opens now.
    else if (flight.phase === "queued") this.begin(sessionId, flight);
    else this.end(sessionId, flight, p);
  }

  /** A queued message names the turn it opened (`turn_started`), which may come before any end. */
  private onStream(p: ChatLifecycleEvents["stream"]): void {
    if (this.flights.size === 0) return;
    const ev = p.event as { type?: unknown; clientMessageId?: unknown } | null;
    if (ev?.type !== "turn_started" || typeof ev.clientMessageId !== "string") return;
    const sessionId = this.env.canonical(p.sessionId);
    const flight = this.flights.get(sessionId);
    if (flight?.phase === "queued" && flight.clientMessageId === ev.clientMessageId) this.begin(sessionId, flight);
  }

  private begin(sessionId: string, flight: Flight): void {
    flight.phase = "started";
    this.dropWaiting(sessionId, flight.schedule.id);
    for (const key of [...this.told]) if (key.startsWith(`${flight.schedule.id}@`)) this.told.delete(key);
    try {
      // Read again: the schedule may have been edited or deleted while its message went in.
      const schedule = getSchedule(flight.schedule.id);
      if (schedule) flight.runId = recordRunStarted(schedule, sessionId, this.env.now());
    } catch (e) {
      log.warn(`could not record the run of schedule ${flight.schedule.id}: ${(e as Error).message}`);
    }
  }

  private end(sessionId: string, flight: Flight, p: ChatLifecycleEvents["turn_ended"]): void {
    this.flights.delete(sessionId);
    if (flight.runId !== null) {
      try { recordRunEnded(flight.runId, p); } catch (e) {
        log.warn(`could not record the end of schedule ${flight.schedule.id}'s run: ${(e as Error).message}`);
      }
    }
    this.wakeSoon(sessionId);
  }

  /** Waiting schedules of the chat, oldest fire first; those that can no longer fire are dropped. */
  private nextWaiting(sessionId: string): Schedule | null {
    const ids = this.waiting.get(sessionId);
    if (!ids) return null;
    const ready: Schedule[] = [];
    for (const id of [...ids]) {
      const schedule = getSchedule(id);
      if (deliverable(schedule)) ready.push(schedule);
      else ids.delete(id);
    }
    if (ids.size === 0) this.waiting.delete(sessionId);
    ready.sort((a, b) => a.pending_since!.localeCompare(b.pending_since!) || a.id - b.id);
    return ready[0] ?? null;
  }

  private pauseAll(sessionId: string, reason: string): void {
    for (const id of [...(this.waiting.get(sessionId) ?? [])]) {
      const schedule = getSchedule(id);
      if (!deliverable(schedule)) continue;
      pauseSessionSchedule(schedule, reason);
      this.notifyPaused(schedule, sessionId, "", undefined, reason);
    }
    this.waiting.delete(sessionId);
  }

  /** Once per pending period: the schedule waits behind a card the user has to answer first. */
  private tellHeldUp(schedule: Schedule, sessionId: string, projectName: string, providerId: string): void {
    const key = `${schedule.id}@${schedule.pending_since}`;
    if (this.told.has(key)) return;
    this.told.add(key);
    const control = this.env.control;
    this.env.notify({
      kind: "waiting", schedule, sessionId, projectName, providerId,
      title: "Schedule is waiting",
      body: `Schedule ${schedule.name} is waiting: an approval is pending in ${this.env.chatTitle(sessionId)}`,
      stillRelevant: () => {
        const live = control()?.liveState(sessionId);
        return !!live && (!!live.card || live.queuedCards > 0);
      },
    });
  }

  private notifyPaused(schedule: Schedule, sessionId: string, projectName: string, providerId: string | undefined, reason: string): void {
    this.env.notify({
      kind: "paused", schedule, sessionId, projectName, ...(providerId ? { providerId } : {}),
      title: `Schedule paused: ${schedule.name}`,
      body: `${reason} Turn it back on once the chat can take it again.`,
    });
  }

  private dropWaiting(sessionId: string, scheduleId: number): void {
    const ids = this.waiting.get(sessionId);
    ids?.delete(scheduleId);
    if (ids?.size === 0) this.waiting.delete(sessionId);
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
    for (const map of [this.waiting, this.flights, this.retries] as Array<Map<string, unknown>>) {
      if (!map.has(oldId)) continue;
      map.set(newId, map.get(oldId));
      map.delete(oldId);
    }
  }
}

/** A session schedule that is on, not paused, and has a fire waiting. */
function deliverable(schedule: Schedule | null): schedule is Schedule {
  return !!schedule && schedule.kind === "session" && !!schedule.enabled && !schedule.paused_reason
    && !!schedule.pending_since && !!schedule.target_session_id;
}
