import { createLogger } from "../logger.ts";
import { getSessionProvider, resolveMigratedSession } from "../db.service.ts";
import {
  getAssistantWatch, insertAssistantWatch, listAssistantWatches, telegramChatsBoundTo, updateAssistantWatch,
  type AssistantWatch,
} from "../assistant-hub/assistant-hub-db.ts";
import { chatControl, type ChatControl, type LiveChatState } from "../chat-control/chat-control.ts";
import { chatLifecycle, type ChatLifecycle, type ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { addNotificationSuppressor } from "../chat-control/notification-suppressor.ts";
import type { NotificationPayload } from "../notification.service.ts";
import { describeTurnStop } from "../../shared/turn-stop.ts";
import { isNoReplyText } from "../../shared/assistant-cards.ts";
import { WAKE_TURNS_PER_HOUR } from "../../shared/assistant-limits.ts";
import type { WatchEventNotice } from "../../types/chat.ts";
import { AssistantWakeQueue, assistantWakeQueue, type WakeItem, type WakeSource } from "../assistant-wake/assistant-wake-queue.ts";
import { watchEvents } from "./watch-events.ts";
import { readTurnEndSince, type TraceTurnEnd } from "./watch-turn-end-reader.ts";
import { awaitsDelivery, MAX_ACTIVE_WATCHES, readWatchState, wakesFor, watchView, writeWatchState, type NotifyKind, type WatchView } from "./watch-state.ts";
import { reportedPush, unreportedPush } from "./watch-push.ts";
import { unnamedChat, watchedChatTitle } from "./watched-chat-title.ts";

/**
 * "Tell me when that chat finishes": watches an Assistant session set on the user's chats, kept
 * in the database so they outlive a restart, and the turns that report on them.
 *
 * - A watched chat's run ending (done, stopped, interrupted by a restart, or the watch expiring
 *   after 24 hours) is recorded on the watch, then reported by waking the Assistant session for
 *   one short turn. That turn opens with a fixed sentence and carries the news in its shared
 *   context; nothing in it may ask the user to approve anything (`UNATTENDED_TURN_REFUSAL`).
 * - A watched chat showing a card wakes nothing: `watch_decision` lets the Telegram relay show
 *   the card with buttons. A model turn per card would cost a turn per tool call, and invite the
 *   model to act on a card the user never saw. Every watch relays its chat's cards; `notifyOn`
 *   only picks which ends of the run wake the Assistant.
 * - Turns are started by the Assistant's wake queue, which caps them per Assistant session per
 *   hour for every kind of news together; news that arrives over the cap, or while the session is
 *   busy, waits and goes into the next turn together.
 * - A report counts as delivered only when its turn ends with an answer. A turn that fails is
 *   tried again; after {@link MAX_REPORT_ATTEMPTS} a push notification names the chat instead.
 *   A turn the user stopped is not a failure: its news is closed, with no retry and no push.
 * - An Assistant session no Telegram chat talks to gets a push naming the watched chat once it
 *   reports, in place of its own "Chat completed" alert, which says nothing about which chat.
 *
 * Driven by the chat lifecycle bus; started by whoever starts the Assistant hub.
 */

export const MAX_ACTIVE_WATCHES_PER_SESSION = MAX_ACTIVE_WATCHES;
export const WATCH_TTL_MS = 24 * 60 * 60_000;
export const MAX_WATCH_TURNS_PER_HOUR = WAKE_TURNS_PER_HOUR;
export const MAX_REPORT_ATTEMPTS = 3;
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
  /** The wake queue that starts the report turns; a private one built from the deps below when absent. */
  queue?: AssistantWakeQueue;
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
  /** The chat is known to be starting a turn now (a caller that just started it), whatever its state reads. */
  armed?: boolean;
}

export type WatchResult =
  | { ok: true; created: boolean; watch: WatchView }
  | { ok: true; alreadyEnded: { kind: "done" | "stopped"; endedAt: string; stopReason?: string } }
  | { ok: false; error: string };

const NOT_RUNNING = "Watching chats is not available in this PPM process.";

async function sendPush(payload: NotificationPayload): Promise<void> {
  const { notificationService } = await import("../notification.service.ts");
  await notificationService.broadcast("done", payload);
}

export class AssistantWatchService implements WakeSource {
  readonly name = "watch";
  private readonly control: () => ChatControl | null;
  private readonly lifecycle: ChatLifecycle;
  private readonly now: () => number;
  private readonly titleOf: (sessionId: string) => string | null;
  private readonly providerOf: (sessionId: string) => string | null;
  private readonly boundChats: (sessionId: string) => string[];
  private readonly notify: (payload: NotificationPayload) => void;
  private readonly turnEndSince: (sessionId: string, sinceMs: number) => TraceTurnEnd | null;
  private readonly addSuppressor: typeof addNotificationSuppressor;
  private readonly queue: AssistantWakeQueue;
  /** A queue built for this service alone (tests): started and stopped with it. */
  private readonly ownsQueue: boolean;

  private stops: Array<() => void> = [];
  /** When the user last wrote in each session: what "already finished" is measured against. */
  private askedAt = new Map<string, number>();

  constructor(deps: AssistantWatchDeps = {}) {
    this.control = deps.control ?? chatControl;
    this.lifecycle = deps.lifecycle ?? chatLifecycle;
    this.now = deps.now ?? Date.now;
    this.titleOf = deps.title ?? watchedChatTitle;
    this.providerOf = deps.provider ?? getSessionProvider;
    this.boundChats = deps.boundChats ?? telegramChatsBoundTo;
    this.notify = deps.notify ?? ((payload) => { sendPush(payload).catch((e) => log.warn(`push failed: ${(e as Error).message}`)); });
    this.turnEndSince = deps.turnEndSince ?? readTurnEndSince;
    this.addSuppressor = deps.addSuppressor ?? addNotificationSuppressor;
    this.ownsQueue = !deps.queue;
    this.queue = deps.queue ?? new AssistantWakeQueue({
      control: this.control, lifecycle: this.lifecycle, now: this.now, provider: this.providerOf,
      ...(deps.tickMs !== undefined ? { tickMs: deps.tickMs } : {}),
      ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
      ...(deps.turnTimeoutMs !== undefined ? { turnTimeoutMs: deps.turnTimeoutMs } : {}),
    });
  }

  get running(): boolean {
    return this.stops.length > 0;
  }

  /** Subscribes, settles what a restart left behind, and joins the wake queue. Calling it twice changes nothing. */
  start(): void {
    if (this.running) return;
    this.stops = [
      this.lifecycle.on("user_message", (p) => this.onUserMessage(p)),
      this.lifecycle.on("approval_shown", (p) => this.onApprovalShown(p)),
      this.lifecycle.on("turn_ended", (p) => this.onTurnEnded(p)),
      this.lifecycle.on("migrated", (p) => this.onMigrated(p.oldSessionId, p.newSessionId)),
      this.addSuppressor((sessionId, kind) => kind === "done" && this.holdsAlertFor(this.canon(sessionId))),
      this.queue.addSource(this),
    ];
    try {
      this.reconcile();
    } catch (e) {
      log.warn(`could not settle the watches a restart left: ${(e as Error).message}`);
    }
    this.queue.start();
    this.tick();
    log.info("Assistant watches started");
  }

  stop(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    if (this.ownsQueue) this.queue.stop();
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
    // A card already up is one the user should see now, not at the next one. Relayed whatever
    // `notifyOn` says: the run cannot end while its card waits unseen.
    if (live?.card) this.relayCard(watch, live.card);
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
    // Every watch on the chat relays it: `notifyOn` picks which ends wake the Assistant, and a
    // card nobody sees would keep the run from reaching any of them.
    for (const w of listAssistantWatches({ status: "active", targetSessionId: this.canon(p.sessionId) })) {
      this.relayCard(w, p.card);
    }
  }

  private onTurnEnded(p: ChatLifecycleEvents["turn_ended"]): void {
    // The Assistant's own report turn ending is the wake queue's; this hears the watched chats.
    const id = this.canon(p.sessionId);
    for (const w of listAssistantWatches({ status: "active", targetSessionId: id })) {
      this.fire(w, this.notice(w, {
        kind: p.outcome === "done" ? "done" : "stopped",
        at: this.now(),
        ...(p.finalText ? { finalText: p.finalText } : {}),
        ...(p.outcome !== "done" ? { stopReason: stopReasonOf(p) } : {}),
      }));
    }
  }

  private onMigrated(oldId: string, newId: string): void {
    if (!this.askedAt.has(oldId)) return;
    this.askedAt.set(newId, this.askedAt.get(oldId)!);
    this.askedAt.delete(oldId);
  }

  /** The Assistant's own "Chat completed" is held back while a report turn runs where a push of ours replaces it. */
  private holdsAlertFor(sessionId: string): boolean {
    return this.queue.reporting(sessionId) && this.boundChats(sessionId).length === 0;
  }

  // ── News ────────────────────────────────────────────────────────────────────

  private notice(w: AssistantWatch, e: Pick<WatchEventNotice, "kind" | "at" | "finalText" | "stopReason">): WatchEventNotice {
    return {
      watchId: w.id,
      project: w.targetProject,
      sessionId: w.targetSessionId,
      providerId: w.targetProvider,
      title: this.nameOf(w.targetSessionId),
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
    if (recorded && !silent && report) this.queue.schedule(w.assistantSessionId);
  }

  private relayCard(w: AssistantWatch, card: NonNullable<LiveChatState["card"]>): void {
    watchEvents.emit("watch_decision", {
      watchId: w.id,
      assistantSessionId: w.assistantSessionId,
      targetSessionId: w.targetSessionId,
      targetProject: w.targetProject,
      targetProvider: w.targetProvider,
      targetTitle: this.nameOf(w.targetSessionId),
      card,
    });
  }

  // ── Watch turns ─────────────────────────────────────────────────────────────

  /** Starts a report turn for this session now if the wake queue lets it (tests call this). */
  pump(assistantSessionId: string): Promise<void> {
    return this.queue.pump(assistantSessionId);
  }

  /** The wake queue's view: the Assistant sessions with watch news not yet reported. */
  sessions(): string[] {
    return [...new Set(listAssistantWatches().filter(awaitsDelivery).map((w) => w.assistantSessionId))];
  }

  /** Watch news waiting for this session, in the order it happened. */
  pending(assistantSessionId: string): WakeItem[] {
    if (!this.running) return [];
    return listAssistantWatches({ assistantSessionId: this.canon(assistantSessionId) }).filter(awaitsDelivery)
      .sort((a, b) => (a.firedAt ?? 0) - (b.firedAt ?? 0))
      .flatMap((w) => {
        const event = readWatchState(w).event;
        return event ? [{ key: w.id, at: w.firedAt ?? 0, watch: event }] : [];
      });
  }

  private rowsOf(items: WakeItem[]): AssistantWatch[] {
    return items.map((i) => getAssistantWatch(i.key)).filter((w): w is AssistantWatch => !!w && awaitsDelivery(w));
  }

  delivered(id: string, items: WakeItem[], text: string): void {
    const now = this.now();
    const reported: WatchEventNotice[] = [];
    for (const w of this.rowsOf(items)) {
      if (!updateAssistantWatch(w.id, { deliveredAt: now }, { ifStatus: w.status })) continue;
      const event = readWatchState(w).event;
      if (!event) continue;
      reported.push(event);
      watchEvents.emit("watch_reported", {
        watchId: w.id, assistantSessionId: id, targetSessionId: w.targetSessionId, targetProject: w.targetProject,
        targetTitle: event.title, kind: event.kind, text,
      });
    }
    // An answer that says there is nothing to add needs no push of its own.
    if (reported.length > 0 && this.boundChats(id).length === 0 && !isNoReplyText(text)) {
      this.notify(reportedPush(reported, text, { sessionId: id, providerId: this.providerOf(id) ?? "claude" }));
    }
  }

  /** News whose report the user cut short: closed without a retry, a push or `watch_reported`. */
  ended(id: string, items: WakeItem[], by: string): void {
    const rows = this.rowsOf(items);
    log.info(`session=${id} watch turn stopped by ${by}: ${rows.length} watch(es) closed unreported`);
    const now = this.now();
    for (const w of rows) updateAssistantWatch(w.id, { deliveredAt: now }, { ifStatus: w.status });
  }

  /** One more failed attempt for each watch; those out of attempts are pushed to the user as they are. */
  failed(id: string, items: WakeItem[], _why: string): boolean {
    const rows = this.rowsOf(items);
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
    if (exhausted.length > 0) {
      this.notify(unreportedPush(exhausted, { sessionId: id, providerId: this.providerOf(id) ?? "claude" }));
    }
    return retry;
  }

  // ── Clock and restart ───────────────────────────────────────────────────────

  /**
   * Expires overdue watches (the queue calls {@link expire} first), then the wake queue gives up on
   * silent turns and starts the turns its cap or a failure held back. The queue's own clock runs
   * the same tick.
   */
  tick(): void {
    if (!this.running) return;
    this.queue.tick();
  }

  /** The wake queue's tick hook: watches past their time fire as expired. */
  expire(): void {
    if (!this.running) return;
    try {
      const now = this.now();
      for (const w of listAssistantWatches({ status: "active" })) {
        if (w.expiresAt <= now) this.fire(w, this.notice(w, { kind: "expired", at: now }), false);
      }
    } catch (e) {
      log.warn(`watch expiry check failed: ${(e as Error).message}`);
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
    return watchView(w, this.nameOf(w.targetSessionId));
  }

  /** One name per chat on every surface a watch feeds: the card relay, the report, the list. */
  private nameOf(sessionId: string): string {
    try {
      return this.titleOf(sessionId) ?? unnamedChat(sessionId);
    } catch (e) {
      log.warn(`session=${sessionId} could not read its title: ${(e as Error).message}`);
      return unnamedChat(sessionId);
    }
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
export const assistantWatchService = new AssistantWatchService({ queue: assistantWakeQueue });
