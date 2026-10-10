import { createLogger } from "../logger.ts";
import { getSessionProvider, getSessionTitle, resolveMigratedSession } from "../db.service.ts";
import {
  getAssistantWatch, insertAssistantWatch, listAssistantWatches, telegramChatsBoundTo, updateAssistantWatch,
  type AssistantWatch,
} from "../assistant-hub/assistant-hub-db.ts";
import { chatControl, CHAT_BUSY, type ChatControl, type LiveChatState } from "../chat-control/chat-control.ts";
import { chatLifecycle, type ChatLifecycle, type ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { addNotificationSuppressor } from "../chat-control/notification-suppressor.ts";
import type { NotificationPayload } from "../notification.service.ts";
import { describeTurnStop } from "../../shared/turn-stop.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { WatchEventNotice } from "../../types/chat.ts";
import { WATCH_OPENER } from "./watch-event-text.ts";
import { watchEvents } from "./watch-events.ts";
import { readTurnEndSince, type TraceTurnEnd } from "./watch-turn-end-reader.ts";
import { awaitsDelivery, MAX_ACTIVE_WATCHES, readWatchState, wakesFor, watchView, writeWatchState, type NotifyKind, type WatchView } from "./watch-state.ts";
import { firstLine, reportedPush, unreportedPush } from "./watch-push.ts";

/**
 * "Tell me when that chat finishes": watches an Assistant session set on the user's chats, kept
 * in the database so they outlive a restart, and the turns that report on them.
 *
 * - A watched chat's run ending (done, stopped, interrupted by a restart, or the watch expiring
 *   after 24 hours) is recorded on the watch, then reported by waking the Assistant session for
 *   one short turn. That turn opens with a fixed sentence and carries the news in its shared
 *   context; nothing in it may ask the user to approve anything (`WATCH_TURN_REFUSAL`).
 * - A watched chat showing a card wakes nothing: `watch_decision` lets the Telegram relay show
 *   the card with buttons. A model turn per card would cost a turn per tool call, and invite the
 *   model to act on a card the user never saw.
 * - Watch turns are capped per Assistant session per hour; news that arrives over the cap, or
 *   while the session is busy, waits and goes into the next turn together.
 * - A report counts as delivered only when its turn ends with an answer. A turn that fails is
 *   tried again; after {@link MAX_REPORT_ATTEMPTS} a push notification names the chat instead.
 * - An Assistant session no Telegram chat talks to gets a push naming the watched chat once it
 *   reports, in place of its own "Chat completed" alert, which says nothing about which chat.
 *
 * Driven by the chat lifecycle bus; started by whoever starts the Assistant hub.
 */

export const MAX_ACTIVE_WATCHES_PER_SESSION = MAX_ACTIVE_WATCHES;
export const WATCH_TTL_MS = 24 * 60 * 60_000;
export const MAX_WATCH_TURNS_PER_HOUR = 6;
export const MAX_REPORT_ATTEMPTS = 3;
const HOUR_MS = 60 * 60_000;
/** How long after a failed watch turn the next one may start. */
const RETRY_DELAY_MS = 60_000;
/** A watch turn that has said nothing for this long counts as failed. */
const WATCH_TURN_TIMEOUT_MS = 20 * 60_000;
/** How often expiries, retries and news held back by the hourly cap are looked at. */
const TICK_MS = 30_000;
/** How many sessions' "the user last asked at" is remembered. */
const MAX_ASKED_RECORDS = 1_000;

const log = createLogger("assistant-watch");

export interface AssistantWatchDeps {
  control?: () => ChatControl | null;
  lifecycle?: ChatLifecycle;
  now?: () => number;
  title?: (sessionId: string) => string | null;
  provider?: (sessionId: string) => string | null;
  boundChats?: (sessionId: string) => string[];
  notify?: (payload: NotificationPayload) => void;
  turnEndSince?: (sessionId: string, sinceMs: number) => TraceTurnEnd | null;
  addSuppressor?: typeof addNotificationSuppressor;
  tickMs?: number;
  retryDelayMs?: number;
  turnTimeoutMs?: number;
}

export interface WatchRequest {
  assistantSessionId: string;
  targetSessionId: string;
  targetProject: string;
  targetProvider: string;
  notifyOn: NotifyKind[];
  /** The chat is known to be starting a turn now (`chat_start`), whatever its state reads. */
  armed?: boolean;
}

export type WatchResult =
  | { ok: true; created: boolean; watch: WatchView }
  | { ok: true; alreadyEnded: { kind: "done" | "stopped"; endedAt: string; stopReason?: string } }
  | { ok: false; error: string };

/** One watch turn: started (`sent`) or being started, and the news it carries. */
interface WatchTurn {
  watchIds: string[];
  startedAt: number;
  sent: boolean;
  /** A turn end heard while the message was still on its way, settled once it is known to be ours. */
  earlyEnd?: ChatLifecycleEvents["turn_ended"];
}

const NOT_RUNNING = "Watching chats is not available in this PPM process.";

async function sendPush(payload: NotificationPayload): Promise<void> {
  const { notificationService } = await import("../notification.service.ts");
  await notificationService.broadcast("done", payload);
}

export class AssistantWatchService {
  private readonly control: () => ChatControl | null;
  private readonly lifecycle: ChatLifecycle;
  private readonly now: () => number;
  private readonly titleOf: (sessionId: string) => string | null;
  private readonly providerOf: (sessionId: string) => string | null;
  private readonly boundChats: (sessionId: string) => string[];
  private readonly notify: (payload: NotificationPayload) => void;
  private readonly turnEndSince: (sessionId: string, sinceMs: number) => TraceTurnEnd | null;
  private readonly addSuppressor: typeof addNotificationSuppressor;
  private readonly tickMs: number;
  private readonly retryDelayMs: number;
  private readonly turnTimeoutMs: number;

  private stops: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Watch turns, by Assistant session (current id). */
  private turns = new Map<string, WatchTurn>();
  /** When each Assistant session's watch turns started, within the last hour. */
  private turnTimes = new Map<string, number[]>();
  /** No watch turn before this, after one failed. */
  private retryAt = new Map<string, number>();
  /** When the user last wrote in each session: what "already finished" is measured against. */
  private askedAt = new Map<string, number>();

  constructor(deps: AssistantWatchDeps = {}) {
    this.control = deps.control ?? chatControl;
    this.lifecycle = deps.lifecycle ?? chatLifecycle;
    this.now = deps.now ?? Date.now;
    this.titleOf = deps.title ?? getSessionTitle;
    this.providerOf = deps.provider ?? getSessionProvider;
    this.boundChats = deps.boundChats ?? telegramChatsBoundTo;
    this.notify = deps.notify ?? ((payload) => { sendPush(payload).catch((e) => log.warn(`push failed: ${(e as Error).message}`)); });
    this.turnEndSince = deps.turnEndSince ?? readTurnEndSince;
    this.addSuppressor = deps.addSuppressor ?? addNotificationSuppressor;
    this.tickMs = deps.tickMs ?? TICK_MS;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? WATCH_TURN_TIMEOUT_MS;
  }

  get running(): boolean {
    return this.stops.length > 0;
  }

  /** Subscribes, settles what a restart left behind, and starts the clock. Calling it twice changes nothing. */
  start(): void {
    if (this.running) return;
    this.stops = [
      this.lifecycle.on("user_message", (p) => this.onUserMessage(p)),
      this.lifecycle.on("approval_shown", (p) => this.onApprovalShown(p)),
      this.lifecycle.on("approval_resolved", (p) => this.schedule(this.canon(p.sessionId))),
      this.lifecycle.on("turn_ended", (p) => this.onTurnEnded(p)),
      this.lifecycle.on("migrated", (p) => this.onMigrated(p.oldSessionId, p.newSessionId)),
      this.addSuppressor((sessionId, kind) => kind === "done" && this.holdsAlertFor(this.canon(sessionId))),
    ];
    try {
      this.reconcile();
    } catch (e) {
      log.warn(`could not settle the watches a restart left: ${(e as Error).message}`);
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
    this.tick();
    log.info("Assistant watches started");
  }

  stop(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
  }

  // ── What the Assistant's tools call ─────────────────────────────────────────

  watch(req: WatchRequest): WatchResult {
    if (!this.running) return { ok: false, error: NOT_RUNNING };
    const assistant = this.canon(req.assistantSessionId);
    const target = this.canon(req.targetSessionId);
    if (assistant === target) return { ok: false, error: "A session cannot watch itself." };
    const mine = listAssistantWatches({ status: "active", assistantSessionId: assistant });
    const existing = mine.find((w) => w.targetSessionId === target);
    if (existing) return { ok: true, created: false, watch: this.view(existing) };
    if (mine.length >= MAX_ACTIVE_WATCHES_PER_SESSION) {
      return { ok: false, error: `This conversation already watches ${MAX_ACTIVE_WATCHES_PER_SESSION} chats; stop one with chat_unwatch first.` };
    }
    const live = this.control()?.liveState(target) ?? null;
    const running = req.armed === true || (live?.running ?? false);
    if (!running) {
      // It may have finished between the user asking and this call: say so rather than wait for a next run.
      const ended = this.safeTurnEnd(target, this.askedAt.get(assistant) ?? this.now());
      if (ended) {
        return { ok: true, alreadyEnded: { kind: ended.kind, endedAt: new Date(ended.at).toISOString(), ...(ended.stopReason ? { stopReason: ended.stopReason } : {}) } };
      }
    }
    const now = this.now();
    const row = insertAssistantWatch({
      id: crypto.randomUUID(),
      assistantSessionId: assistant,
      targetSessionId: target,
      targetProject: req.targetProject,
      targetProvider: req.targetProvider,
      createdAt: now,
      expiresAt: now + WATCH_TTL_MS,
      armedRunning: running,
    });
    updateAssistantWatch(row.id, { eventJson: writeWatchState({ notifyOn: req.notifyOn }) });
    const watch = getAssistantWatch(row.id)!;
    // A card already up is one the user should see now, not at the next one.
    if (live?.card && req.notifyOn.includes("decision")) this.relayCard(watch, live.card);
    return { ok: true, created: true, watch: this.view(watch) };
  }

  /** Stops a watch this session set, its unreported news included; an error when there is none. */
  unwatch(assistantSessionId: string, watchId: string): { ok: true; watch: WatchView } | { ok: false; error: string } {
    if (!this.running) return { ok: false, error: NOT_RUNNING };
    const w = getAssistantWatch(watchId);
    if (!w || w.assistantSessionId !== this.canon(assistantSessionId)) return { ok: false, error: "This conversation has no watch with that id; see chat_list_watches." };
    if (w.status !== "active" && !awaitsDelivery(w)) return { ok: false, error: `That watch is already over (${w.status}).` };
    if (!updateAssistantWatch(w.id, { status: "cancelled" }, { ifStatus: w.status })) return { ok: false, error: "That watch changed meanwhile; see chat_list_watches." };
    return { ok: true, watch: this.view(getAssistantWatch(w.id)!) };
  }

  /** This session's watches: running ones, unreported news, and those of the last day. */
  list(assistantSessionId: string): WatchView[] {
    const since = this.now() - WATCH_TTL_MS;
    return listAssistantWatches({ assistantSessionId })
      .filter((w) => w.status === "active" || awaitsDelivery(w) || w.createdAt >= since)
      .slice(-50)
      .map((w) => this.view(w));
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  private onUserMessage(p: ChatLifecycleEvents["user_message"]): void {
    const id = this.canon(p.sessionId);
    if (p.origin === "ws" || p.origin === "telegram") this.noteAsked(id);
    // A watched chat starting a turn: if PPM stops before it ends, the turn was interrupted.
    for (const w of listAssistantWatches({ status: "active", targetSessionId: id })) {
      if (!w.armedRunning) updateAssistantWatch(w.id, { armedRunning: true }, { ifStatus: "active" });
    }
  }

  private onApprovalShown(p: ChatLifecycleEvents["approval_shown"]): void {
    for (const w of listAssistantWatches({ status: "active", targetSessionId: this.canon(p.sessionId) })) {
      if (readWatchState(w).notifyOn.includes("decision")) this.relayCard(w, p.card);
    }
  }

  private onTurnEnded(p: ChatLifecycleEvents["turn_ended"]): void {
    const id = this.canon(p.sessionId);
    const turn = this.turns.get(id);
    if (turn && !turn.sent) turn.earlyEnd = p;
    else if (turn) this.finishWatchTurn(id, turn, p);
    for (const w of listAssistantWatches({ status: "active", targetSessionId: id })) {
      this.fire(w, this.notice(w, {
        kind: p.outcome === "done" ? "done" : "stopped",
        at: this.now(),
        ...(p.finalText ? { finalText: p.finalText } : {}),
        ...(p.outcome !== "done" ? { stopReason: stopReasonOf(p) } : {}),
      }));
    }
    // A session that just went idle may have news waiting for it.
    if (!turn) this.schedule(id);
  }

  private onMigrated(oldId: string, newId: string): void {
    for (const map of [this.turns, this.turnTimes, this.retryAt, this.askedAt] as Array<Map<string, unknown>>) {
      if (!map.has(oldId)) continue;
      map.set(newId, map.get(oldId));
      map.delete(oldId);
    }
  }

  /** The Assistant's own "Chat completed" is held back while a watch turn runs where a push of ours replaces it. */
  private holdsAlertFor(sessionId: string): boolean {
    return this.turns.get(sessionId)?.sent === true && this.boundChats(sessionId).length === 0;
  }

  // ── News ────────────────────────────────────────────────────────────────────

  private notice(w: AssistantWatch, e: Pick<WatchEventNotice, "kind" | "at" | "finalText" | "stopReason">): WatchEventNotice {
    return {
      watchId: w.id,
      project: w.targetProject,
      sessionId: w.targetSessionId,
      providerId: w.targetProvider,
      title: this.titleOf(w.targetSessionId) ?? `Session ${w.targetSessionId.slice(0, 8)}`,
      ...e,
    };
  }

  /**
   * Records the news once (the first event wins); news nobody asked for ends the watch quietly.
   * `report: false` leaves the turn to the caller, which records several and then starts one
   * turn for all of them.
   */
  private fire(w: AssistantWatch, event: WatchEventNotice, report = true): void {
    const state = readWatchState(w);
    const silent = !wakesFor(event.kind, state.notifyOn);
    const now = this.now();
    const recorded = updateAssistantWatch(w.id, {
      status: event.kind === "expired" ? "expired" : "fired",
      lastEvent: event.kind,
      firedAt: now,
      eventJson: writeWatchState({ ...state, event }),
      ...(silent ? { deliveredAt: now } : {}),
    }, { ifStatus: "active" });
    if (recorded && !silent && report) this.schedule(w.assistantSessionId);
  }

  private relayCard(w: AssistantWatch, card: NonNullable<LiveChatState["card"]>): void {
    watchEvents.emit("watch_decision", {
      watchId: w.id,
      assistantSessionId: w.assistantSessionId,
      targetSessionId: w.targetSessionId,
      targetProject: w.targetProject,
      targetProvider: w.targetProvider,
      targetTitle: this.titleOf(w.targetSessionId) ?? `Session ${w.targetSessionId.slice(0, 8)}`,
      card,
    });
  }

  // ── Watch turns ─────────────────────────────────────────────────────────────

  /**
   * Starts a watch turn once the current event has played out. Mostly heard from a `turn_ended`,
   * which the chat emits while its stream is still unwinding: a message sent at that moment
   * would be pushed into a stream about to close, and lost with it.
   */
  private schedule(assistantSessionId: string): void {
    setTimeout(() => {
      this.pump(assistantSessionId).catch((e) => log.warn(`session=${assistantSessionId} could not report watch news: ${(e as Error).message}`));
    }, 0);
  }

  /** Starts a watch turn carrying every piece of news waiting for this session, when it may. */
  async pump(assistantSessionId: string): Promise<void> {
    const id = this.canon(assistantSessionId);
    if (!this.running || this.turns.has(id)) return;
    // In the order it happened.
    const pending = listAssistantWatches({ assistantSessionId: id }).filter(awaitsDelivery)
      .sort((a, b) => (a.firedAt ?? 0) - (b.firedAt ?? 0));
    if (pending.length === 0) return;
    const now = this.now();
    if ((this.retryAt.get(id) ?? 0) > now) return;
    const recent = (this.turnTimes.get(id) ?? []).filter((t) => t > now - HOUR_MS);
    this.turnTimes.set(id, recent);
    if (recent.length >= MAX_WATCH_TURNS_PER_HOUR) return;
    const control = this.control();
    if (!control) return;
    const live = control.liveState(id);
    if (live && (live.running || live.card)) return;

    const events = pending.map((w) => readWatchState(w).event).filter((e): e is WatchEventNotice => !!e);
    if (events.length === 0) return;
    const turn: WatchTurn = { watchIds: pending.map((w) => w.id), startedAt: now, sent: false };
    this.turns.set(id, turn);
    let result: Awaited<ReturnType<ChatControl["sendUserMessage"]>>;
    try {
      result = await control.sendUserMessage(id, WATCH_OPENER, {
        origin: "watch",
        projectName: ASSISTANT_PROJECT_NAME,
        providerId: this.providerOf(id) ?? live?.providerId ?? "claude",
        watchEvents: events,
      });
    } catch (e) {
      result = { ok: false, error: (e as Error)?.message ?? String(e) };
    }
    if (this.turns.get(id) !== turn) return; // stopped meanwhile
    if (!result.ok) {
      this.turns.delete(id);
      // The turn or card in the way ends with an event that brings this back.
      if (result.error === CHAT_BUSY) return;
      this.recordFailure(id, pending, `the watch turn could not start: ${result.error}`);
      return;
    }
    turn.sent = true;
    recent.push(now);
    const current = this.canon(result.sessionId);
    if (current !== id) this.onMigrated(id, current);
    if (turn.earlyEnd) this.finishWatchTurn(current, turn, turn.earlyEnd);
  }

  private finishWatchTurn(id: string, turn: WatchTurn, end: ChatLifecycleEvents["turn_ended"]): void {
    this.turns.delete(id);
    const rows = turn.watchIds.map((watchId) => getAssistantWatch(watchId)).filter((w): w is AssistantWatch => !!w && awaitsDelivery(w));
    const text = end.finalText?.trim();
    if (end.outcome === "done" && text) {
      this.retryAt.delete(id);
      const now = this.now();
      const reported: WatchEventNotice[] = [];
      for (const w of rows) {
        if (!updateAssistantWatch(w.id, { deliveredAt: now }, { ifStatus: w.status })) continue;
        const event = readWatchState(w).event;
        if (!event) continue;
        reported.push(event);
        watchEvents.emit("watch_reported", {
          watchId: w.id, assistantSessionId: id, targetSessionId: w.targetSessionId, targetProject: w.targetProject,
          targetTitle: event.title, kind: event.kind, text,
        });
      }
      if (reported.length > 0 && this.boundChats(id).length === 0) {
        this.notify(reportedPush(reported, text, { sessionId: id, providerId: this.providerOf(id) ?? end.providerId }));
      }
    } else {
      const why = end.outcome === "done" ? "it ended without an answer" : `it ${end.outcome}${end.error ? `: ${firstLine(end.error, 200)}` : ""}`;
      this.recordFailure(id, rows, `the watch turn did not report: ${why}`);
    }
    this.schedule(id);
  }

  /** One more failed attempt for each watch; those out of attempts are pushed to the user as they are. */
  private recordFailure(id: string, rows: AssistantWatch[], why: string): void {
    log.warn(`session=${id} ${why}`);
    const now = this.now();
    const exhausted: WatchEventNotice[] = [];
    let retry = false;
    for (const w of rows) {
      const state = readWatchState(w);
      const attempts = (state.attempts ?? 0) + 1;
      const done = attempts >= MAX_REPORT_ATTEMPTS;
      const saved = updateAssistantWatch(w.id, {
        eventJson: writeWatchState({ ...state, attempts }),
        ...(done ? { deliveredAt: now } : {}),
      }, { ifStatus: w.status });
      if (!saved) continue;
      if (done && state.event) exhausted.push(state.event);
      if (!done) retry = true;
    }
    if (retry) this.retryAt.set(id, now + this.retryDelayMs);
    if (exhausted.length > 0) {
      this.notify(unreportedPush(exhausted, { sessionId: id, providerId: this.providerOf(id) ?? "claude" }));
    }
  }

  // ── Clock and restart ───────────────────────────────────────────────────────

  /** Expires overdue watches, gives up on silent watch turns, and starts turns the cap or a failure held back. */
  tick(): void {
    if (!this.running) return;
    try {
      const now = this.now();
      for (const w of listAssistantWatches({ status: "active" })) {
        if (w.expiresAt <= now) this.fire(w, this.notice(w, { kind: "expired", at: now }), false);
      }
      for (const [id, turn] of [...this.turns]) {
        if (!turn.sent || now - turn.startedAt < this.turnTimeoutMs) continue;
        this.turns.delete(id);
        const rows = turn.watchIds.map((watchId) => getAssistantWatch(watchId)).filter((w): w is AssistantWatch => !!w && awaitsDelivery(w));
        this.recordFailure(id, rows, "the watch turn never ended");
      }
      const waiting = new Set(listAssistantWatches().filter(awaitsDelivery).map((w) => w.assistantSessionId));
      for (const id of waiting) this.schedule(id);
    } catch (e) {
      log.warn(`watch tick failed: ${(e as Error).message}`);
    }
  }

  /**
   * A restart ends every running turn with no event. A watch armed on a running chat whose trace
   * shows no end since the watch was set saw its turn cut off: interrupted. One whose trace does
   * show an end missed only the event, and is fired from the trace.
   */
  private reconcile(): void {
    const now = this.now();
    const control = this.control();
    for (const w of listAssistantWatches({ status: "active" })) {
      if (w.expiresAt <= now) {
        this.fire(w, this.notice(w, { kind: "expired", at: now }), false);
        continue;
      }
      if (!w.armedRunning || control?.liveState(w.targetSessionId)?.running) continue;
      const ended = this.safeTurnEnd(w.targetSessionId, w.createdAt);
      this.fire(w, this.notice(w, ended
        ? { kind: ended.kind, at: ended.at, ...(ended.stopReason ? { stopReason: ended.stopReason } : {}) }
        : { kind: "interrupted", at: now }), false);
    }
    // Reported by the tick that follows, one turn per Assistant session.
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private canon(sessionId: string): string {
    return resolveMigratedSession(sessionId);
  }

  private noteAsked(id: string): void {
    this.askedAt.delete(id);
    this.askedAt.set(id, this.now());
    if (this.askedAt.size > MAX_ASKED_RECORDS) this.askedAt.delete(this.askedAt.keys().next().value!);
  }

  private safeTurnEnd(sessionId: string, sinceMs: number): TraceTurnEnd | null {
    try {
      return this.turnEndSince(sessionId, sinceMs);
    } catch (e) {
      log.warn(`session=${sessionId} could not read how its last turn ended: ${(e as Error).message}`);
      return null;
    }
  }

  private view(w: AssistantWatch): WatchView {
    return watchView(w, this.titleOf(w.targetSessionId) ?? `Session ${w.targetSessionId.slice(0, 8)}`);
  }
}

function stopReasonOf(p: ChatLifecycleEvents["turn_ended"]): string {
  if (p.stop) {
    const { title, detail } = describeTurnStop(p.stop);
    return [title, detail].filter(Boolean).join(" — ");
  }
  if (p.error) return p.error;
  return "Its turn was stopped before it finished.";
}

/** The process-wide service; the Assistant hub starts and stops it. */
export const assistantWatchService = new AssistantWatchService();
