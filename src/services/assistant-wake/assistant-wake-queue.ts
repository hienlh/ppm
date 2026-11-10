import { createLogger } from "../logger.ts";
import { getSessionProvider, resolveMigratedSession } from "../db.service.ts";
import { chatControl, CHAT_BUSY, type ChatControl } from "../chat-control/chat-control.ts";
import { chatLifecycle, type ChatLifecycle, type ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { WAKE_TURNS_PER_HOUR } from "../../shared/assistant-limits.ts";
import type { WakeNewsNotice } from "../../shared/assistant-wake-news.ts";
import type { WatchEventNotice } from "../../types/chat.ts";
import { WATCH_OPENER } from "../assistant-watch/watch-event-text.ts";
import { firstLine } from "../assistant-watch/watch-push.ts";
import { NEWS_OPENER } from "./wake-news-text.ts";
import { assistantClock } from "./assistant-clock.ts";
import { quietNow } from "./wake-quiet-hours.ts";

/**
 * The one door through which PPM starts a PPM Assistant turn on its own. Sources (watches, manager
 * reports, late manager replies) keep their news; the queue decides when a turn may carry it:
 * at most {@link WAKE_TURNS_PER_HOUR} per Assistant session, never while that session runs a turn or
 * shows a card, never during quiet hours unless something urgent waits, and after a failed turn only
 * once the retry delay is over. News held back goes into the next turn together.
 *
 * A turn counts its news delivered only when it ends with an answer. A turn that fails is reported
 * to each source, which counts attempts and gives up its own way; one the user stopped closes the
 * news without a retry.
 */

export interface WakeItem {
  /** Unique within its source. */
  key: string;
  at: number;
  /** Starts a turn during quiet hours. */
  urgent?: boolean;
  watch?: WatchEventNotice;
  news?: WakeNewsNotice;
}

export interface WakeSource {
  name: string;
  /** Assistant sessions this source has news for (any id they went by). */
  sessions(): string[];
  /** News waiting for this session, oldest first. */
  pending(sessionId: string): WakeItem[];
  delivered(sessionId: string, items: WakeItem[], text: string): void;
  /** One more failed attempt; true while the items should be tried again. */
  failed(sessionId: string, items: WakeItem[], why: string): boolean;
  /** The user stopped the turn: the news is over. */
  ended(sessionId: string, items: WakeItem[], by: string): void;
  /** Called on every tick before the queue looks for news (expiries). */
  expire?(): void;
}

export interface WakeQueueDeps {
  control?: () => ChatControl | null;
  lifecycle?: ChatLifecycle;
  now?: () => number;
  provider?: (sessionId: string) => string | null;
  quiet?: () => boolean;
  tickMs?: number;
  retryDelayMs?: number;
  turnTimeoutMs?: number;
}

interface WakeTurn {
  batch: Array<{ source: WakeSource; items: WakeItem[] }>;
  startedAt: number;
  sent: boolean;
  earlyEnd?: ChatLifecycleEvents["turn_ended"];
}

const HOUR_MS = 60 * 60_000;
const log = createLogger("assistant-wake");

export class AssistantWakeQueue {
  private readonly control: () => ChatControl | null;
  private readonly lifecycle: ChatLifecycle;
  private readonly now: () => number;
  private readonly providerOf: (sessionId: string) => string | null;
  private readonly quiet: () => boolean;
  private readonly tickMs: number;
  private readonly retryDelayMs: number;
  private readonly turnTimeoutMs: number;
  private readonly sources = new Map<string, WakeSource>();
  private stops: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private turns = new Map<string, WakeTurn>();
  private turnTimes = new Map<string, number[]>();
  private retryAt = new Map<string, number>();

  constructor(deps: WakeQueueDeps = {}) {
    this.control = deps.control ?? chatControl;
    this.lifecycle = deps.lifecycle ?? chatLifecycle;
    this.now = deps.now ?? (() => assistantClock.now());
    this.providerOf = deps.provider ?? getSessionProvider;
    this.quiet = deps.quiet ?? quietNow;
    this.tickMs = deps.tickMs ?? 30_000;
    this.retryDelayMs = deps.retryDelayMs ?? 60_000;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? 20 * 60_000;
  }

  get running(): boolean { return this.stops.length > 0; }

  addSource(source: WakeSource): () => void {
    this.sources.set(source.name, source);
    return () => { if (this.sources.get(source.name) === source) this.sources.delete(source.name); };
  }

  /** Subscribes and starts the clock; calling it twice changes nothing. */
  start(): void {
    if (this.running) return;
    this.stops = [
      this.lifecycle.on("approval_resolved", (p) => this.schedule(p.sessionId)),
      this.lifecycle.on("turn_ended", (p) => this.onTurnEnded(p)),
      this.lifecycle.on("migrated", (p) => this.onMigrated(p.oldSessionId, p.newSessionId)),
    ];
    this.timer = setInterval(() => this.tick(), this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
  }

  /** Whether a turn the queue started is running in this session now. */
  reporting(sessionId: string): boolean { return this.turns.get(resolveMigratedSession(sessionId))?.sent === true; }

  /** The sources whose news the running wake turn of this session carries; empty when none runs. */
  carrying(sessionId: string): string[] {
    const turn = this.turns.get(resolveMigratedSession(sessionId));
    return turn?.sent ? turn.batch.map((b) => b.source.name) : [];
  }

  /** Looks for news once the current event has played out (a turn end is still unwinding its stream). */
  schedule(sessionId: string): void {
    setTimeout(() => {
      this.pump(sessionId).catch((e) => log.warn(`session=${sessionId} could not start a wake turn: ${(e as Error).message}`));
    }, 0);
  }

  async pump(sessionId: string): Promise<void> {
    const id = resolveMigratedSession(sessionId);
    if (!this.running || this.turns.has(id)) return;
    const batch = [...this.sources.values()].map((source) => ({ source, items: source.pending(id) })).filter((b) => b.items.length > 0);
    if (batch.length === 0) return;
    const now = this.now();
    if ((this.retryAt.get(id) ?? 0) > now) return;
    const recent = (this.turnTimes.get(id) ?? []).filter((t) => t > now - HOUR_MS);
    this.turnTimes.set(id, recent);
    if (recent.length >= WAKE_TURNS_PER_HOUR) return;
    const items = batch.flatMap((b) => b.items);
    if (!items.some((i) => i.urgent) && this.safeQuiet()) return;
    const control = this.control();
    if (!control) return;
    const live = control.liveState(id);
    if (live && (live.running || live.card)) return;

    const watchEvents = items.flatMap((i) => (i.watch ? [i.watch] : []));
    const wakeNews = items.flatMap((i) => (i.news ? [i.news] : []));
    const turn: WakeTurn = { batch, startedAt: now, sent: false };
    this.turns.set(id, turn);
    let result: Awaited<ReturnType<ChatControl["sendUserMessage"]>>;
    try {
      result = await control.sendUserMessage(id, watchEvents.length ? WATCH_OPENER : NEWS_OPENER, {
        origin: "watch", projectName: ASSISTANT_PROJECT_NAME, providerId: this.providerOf(id) ?? live?.providerId ?? "claude",
        ...(watchEvents.length ? { watchEvents } : {}), ...(wakeNews.length ? { wakeNews } : {}),
      });
    } catch (e) {
      result = { ok: false, error: (e as Error)?.message ?? String(e) };
    }
    if (this.turns.get(id) !== turn) return; // stopped meanwhile
    if (!result.ok) {
      this.turns.delete(id);
      // The turn or card in the way ends with an event that brings this back.
      if (result.error === CHAT_BUSY) return;
      this.recordFailure(id, batch, `the wake turn could not start: ${result.error}`);
      return;
    }
    turn.sent = true;
    recent.push(now);
    const current = resolveMigratedSession(result.sessionId);
    if (current !== id) this.onMigrated(id, current);
    if (turn.earlyEnd) this.finish(current, turn, turn.earlyEnd);
  }

  /** Gives up on silent turns, lets sources expire news, and starts turns held back by the cap or a failure. */
  tick(): void {
    if (!this.running) return;
    try {
      for (const source of this.sources.values()) this.safely(() => source.expire?.());
      const now = this.now();
      for (const [id, turn] of [...this.turns]) {
        if (!turn.sent || now - turn.startedAt < this.turnTimeoutMs) continue;
        this.turns.delete(id);
        this.recordFailure(id, turn.batch, "the wake turn never ended");
      }
      const sessions = new Set([...this.sources.values()].flatMap((s) => s.sessions()).map((s) => resolveMigratedSession(s)));
      for (const id of sessions) this.schedule(id);
    } catch (e) {
      log.warn(`wake tick failed: ${(e as Error).message}`);
    }
  }

  private onTurnEnded(p: ChatLifecycleEvents["turn_ended"]): void {
    const id = resolveMigratedSession(p.sessionId);
    const turn = this.turns.get(id);
    if (turn && !turn.sent) turn.earlyEnd = p;
    else if (turn) this.finish(id, turn, p);
    // A session that just went idle may have news waiting for it.
    if (!turn) this.schedule(id);
  }

  private finish(id: string, turn: WakeTurn, end: ChatLifecycleEvents["turn_ended"]): void {
    this.turns.delete(id);
    const text = end.finalText?.trim();
    if (end.outcome === "done" && text) {
      this.retryAt.delete(id);
      for (const b of turn.batch) this.safely(() => b.source.delivered(id, b.items, text));
    } else if (end.cancelledBy) {
      log.info(`session=${id} wake turn stopped by ${end.cancelledBy}: its news is closed`);
      this.retryAt.delete(id);
      for (const b of turn.batch) this.safely(() => b.source.ended(id, b.items, end.cancelledBy!));
    } else {
      const why = end.outcome === "done" ? "it ended without an answer" : `it ${end.outcome}${end.error ? `: ${firstLine(end.error, 200)}` : ""}`;
      this.recordFailure(id, turn.batch, `the wake turn did not report: ${why}`);
    }
    this.schedule(id);
  }

  private recordFailure(id: string, batch: WakeTurn["batch"], why: string): void {
    log.warn(`session=${id} ${why}`);
    let retry = false;
    for (const b of batch) this.safely(() => { if (b.source.failed(id, b.items, why)) retry = true; });
    if (retry) this.retryAt.set(id, this.now() + this.retryDelayMs);
  }

  private onMigrated(oldId: string, newId: string): void {
    for (const map of [this.turns, this.turnTimes, this.retryAt] as Array<Map<string, unknown>>) {
      if (!map.has(oldId)) continue;
      map.set(newId, map.get(oldId));
      map.delete(oldId);
    }
  }

  private safeQuiet(): boolean {
    try { return this.quiet(); } catch { return false; }
  }

  private safely(fn: () => void): void {
    try { fn(); } catch (e) { log.warn(`a wake source failed: ${(e as Error).message}`); }
  }
}

/** The process-wide queue; the Assistant hub starts it, and every source registers with it. */
export const assistantWakeQueue = new AssistantWakeQueue();
