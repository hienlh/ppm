/**
 * What happens in a bound Assistant session, shown in the Telegram chats bound to it: the
 * answers as they stream, a line for a message typed in PPM, a line when a watch reports, and
 * the session's approval cards.
 *
 * Listens on `chatLifecycle`, whose listeners run on the chat's hot path, so every handler here
 * only updates memory and queues work on the chat's send lane. Which chats receive an event is
 * decided per event (bound now, and still connected), so a chat bound or revoked mid-turn is
 * picked up or dropped at once; the send lane checks the connection again before each call.
 */
import { chatLifecycle, type ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import type { ChatMessageOrigin } from "../chat-control/chat-control.ts";
import { telegramChatsBoundTo } from "../assistant-hub/assistant-hub-db.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import { describeTurnStop } from "../../shared/turn-stop.ts";
import { canSendTo } from "./assistant-telegram-access.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import type { BridgeStateStore } from "./assistant-telegram-state.ts";
import { TurnRenderer } from "./assistant-telegram-turn-renderer.ts";
import { AssistantTelegramWaitNotes, type WaitNotesDeps } from "./assistant-telegram-wait-notes.ts";
import { WakeTurnGate } from "./assistant-telegram-wake-gate.ts";
import { NEWS_OPENER } from "../assistant-wake/wake-news-text.ts";

/** How much of a message typed in PPM is repeated on Telegram. */
export const MIRRORED_MESSAGE_MAX = 1000;
export const WATCH_NEWS_LINE = "🔔 PPM: news about a watched chat";
export const MANAGER_NEWS_LINE = "🔔 PPM: news from manager chats";
const BOUND_CACHE_MS = 2000;

/** Cards of a bound session, handed to whoever renders them on Telegram. */
export interface MirrorCardSink {
  shown(chatId: string, payload: ChatLifecycleEvents["approval_shown"]): void;
  resolved(payload: ChatLifecycleEvents["approval_resolved"]): void;
}

export interface MirrorDeps {
  queue: AssistantTelegramSendQueue;
  state: BridgeStateStore;
  showToolCalls: () => boolean;
  /** A turn's final answer reached a chat bound to the session. */
  onTurnDelivered: (sessionId: string) => void;
  cards?: MirrorCardSink;
  now?: () => number;
  /** How long-waiting session tools are said in the draft (tests shorten the delay). */
  waitNotes?: Omit<WaitNotesDeps, "renderers">;
}

export class AssistantTelegramMirror {
  /** Live turns: session id → chat id → renderer. */
  private readonly turns = new Map<string, Map<string, TurnRenderer>>();
  private offs: Array<() => void> = [];
  private readonly bound = new Map<string, { at: number; chats: string[] }>();
  private readonly wakeGate = new WakeTurnGate();
  private readonly waitNotes: AssistantTelegramWaitNotes;

  constructor(private readonly deps: MirrorDeps) {
    this.waitNotes = new AssistantTelegramWaitNotes({ ...deps.waitNotes, renderers: (sessionId) => this.live(sessionId) });
  }

  attach(): void {
    if (this.offs.length) return;
    this.offs = [
      chatLifecycle.on("user_message", (p) => this.onUserMessage(p)),
      chatLifecycle.on("stream", (p) => this.onStream(p)),
      chatLifecycle.on("turn_ended", (p) => this.onTurnEnded(p)),
      chatLifecycle.on("migrated", (p) => this.onMigrated(p)),
      chatLifecycle.on("approval_shown", (p) => { for (const chatId of this.chatsFor(p.sessionId)) this.deps.cards?.shown(chatId, p); }),
      chatLifecycle.on("approval_resolved", (p) => this.deps.cards?.resolved(p)),
    ];
  }

  detach(): void {
    for (const off of this.offs.splice(0)) off();
    this.turns.clear();
    this.waitNotes.clear();
  }

  /** Stops writing to a chat: its live turns are abandoned (its lane is emptied by the caller). */
  forgetChat(chatId: string): void {
    for (const byChat of this.turns.values()) byChat.delete(chatId);
  }

  /** A binding changed: the next event reads bindings afresh. */
  invalidate(): void {
    this.bound.clear();
  }

  /**
   * Whether the session's current answer is being written to a connected chat right now. A turn
   * can end before the first draft's `sendMessage` has returned (a short answer ends in a
   * millisecond), so the send queue's "last sent" stamp alone would let a push through for an
   * answer that is on its way to the phone.
   */
  telling(sessionId: string): boolean {
    return this.live(sessionId).length > 0;
  }

  /**
   * Chats that should see this session now: bound to it, and still connected. Every streamed
   * chunk of every chat in PPM asks, so the answer is kept briefly; a binding change clears it,
   * and the send lane checks the connection itself before each call, so a revocation is never
   * late by more than one queued call.
   */
  private chatsFor(sessionId: string): string[] {
    const now = Date.now();
    const cached = this.bound.get(sessionId);
    if (cached && now - cached.at < BOUND_CACHE_MS) return cached.chats;
    let chats: string[] = [];
    try {
      chats = telegramChatsBoundTo(sessionId).filter(canSendTo);
    } catch { /* a malformed id has no chats */ }
    if (this.bound.size > 1000) this.bound.clear();
    this.bound.set(sessionId, { at: now, chats });
    return chats;
  }

  private renderer(sessionId: string, chatId: string, origin: ChatMessageOrigin): TurnRenderer {
    let byChat = this.turns.get(sessionId);
    if (!byChat) this.turns.set(sessionId, byChat = new Map());
    let r = byChat.get(chatId);
    if (!r || r.isFinished) {
      r = new TurnRenderer({
        queue: this.deps.queue, state: this.deps.state, chatId, origin,
        showToolCalls: this.deps.showToolCalls,
        onDelivered: () => this.deps.onTurnDelivered(sessionId),
        ...(this.deps.now ? { now: this.deps.now } : {}),
      });
      byChat.set(chatId, r);
      r.start();
    }
    return r;
  }

  private onUserMessage(p: ChatLifecycleEvents["user_message"]): void {
    // A turn PPM started waits until it has something to say (see WakeTurnGate).
    if (p.origin === "watch" && this.chatsFor(p.sessionId).length > 0) {
      this.wakeGate.hold(p.sessionId, p.text.includes(NEWS_OPENER) ? MANAGER_NEWS_LINE : WATCH_NEWS_LINE);
      return;
    }
    for (const chatId of this.chatsFor(p.sessionId)) {
      const line = mirroredLine(p.origin, p.text, p.imageCount);
      if (line) this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html: line }, { label: "mirrored message" }));
      this.renderer(p.sessionId, chatId, p.origin);
    }
  }

  private onStream(p: ChatLifecycleEvents["stream"]): void {
    const ev = p.event as { type?: string; content?: unknown; tool?: unknown; parentToolUseId?: unknown };
    // A subagent's own text and tools are its business; the answer is the session's.
    if (!ev || ev.parentToolUseId) return;
    if (this.wakeGate.isHeld(p.sessionId)) {
      if (ev.type === "tool_use" && typeof ev.tool === "string") this.wakeGate.tool(p.sessionId, ev.tool);
      else if (ev.type === "text" && typeof ev.content === "string") {
        const released = this.wakeGate.text(p.sessionId, ev.content);
        if (released) this.releaseWake(p.sessionId, released);
      }
      return;
    }
    if (ev.type === "text" && typeof ev.content === "string") {
      // A chat bound while a turn was already running joins it from here.
      for (const chatId of this.chatsFor(p.sessionId)) this.renderer(p.sessionId, chatId, "ws").text(ev.content);
    } else if (ev.type === "tool_use" && typeof ev.tool === "string") {
      const live = this.live(p.sessionId);
      for (const r of live) r.tool(ev.tool);
      // A session tool told to wait can sit for minutes with nothing streaming: the draft says so.
      if (live.length) this.waitNotes.toolStarted(p.sessionId, ev as { tool: string; input?: unknown; toolUseId?: string });
    } else if (ev.type === "tool_result") {
      this.waitNotes.toolEnded((ev as { toolUseId?: string }).toolUseId);
    }
    // An error is not echoed here: the one that ends a turn closes the answer (`turnFooter`),
    // and repeating it would say it twice.
  }

  private live(sessionId: string): TurnRenderer[] {
    const byChat = this.turns.get(sessionId);
    if (!byChat) return [];
    const allowed = new Set(this.chatsFor(sessionId));
    return [...byChat].filter(([chatId, r]) => allowed.has(chatId) && !r.isFinished).map(([, r]) => r);
  }

  /** A held wake turn turned out to say something: its line, tools and text go out as they came. */
  private releaseWake(sessionId: string, held: { text: string; tools: string[]; line?: string }): void {
    for (const chatId of this.chatsFor(sessionId)) {
      this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html: held.line ?? WATCH_NEWS_LINE }, { label: "mirrored message" }));
      const r = this.renderer(sessionId, chatId, "watch");
      for (const tool of held.tools) r.tool(tool);
      if (held.text) r.text(held.text);
    }
  }

  private onTurnEnded(p: ChatLifecycleEvents["turn_ended"]): void {
    this.waitNotes.turnEnded(p.sessionId);
    const held = this.wakeGate.end(p.sessionId, p.outcome);
    if (held) this.releaseWake(p.sessionId, held);
    const footer = turnFooter(p);
    for (const r of this.live(p.sessionId)) r.finish(footer);
    this.turns.delete(p.sessionId);
  }

  private onMigrated(p: ChatLifecycleEvents["migrated"]): void {
    this.wakeGate.rename(p.oldSessionId, p.newSessionId);
    this.waitNotes.renamed(p.oldSessionId, p.newSessionId);
    const byChat = this.turns.get(p.oldSessionId);
    if (!byChat) return;
    this.turns.delete(p.oldSessionId);
    this.turns.set(p.newSessionId, byChat);
  }
}

/** The line a message typed somewhere other than Telegram gets on Telegram; null for none. */
export function mirroredLine(origin: ChatMessageOrigin, text: string, imageCount: number): string | null {
  if (origin === "watch") return WATCH_NEWS_LINE;
  if (origin !== "ws") return null;
  const images = imageCount > 0 ? ` [+${imageCount} image${imageCount === 1 ? "" : "s"}]` : "";
  const body = escapeTelegramHtml(redactForTelegram(truncateText(text, MIRRORED_MESSAGE_MAX)));
  return `🖥 <i>(PPM)</i> ${body}${images}`;
}

/** How a turn that did not simply finish is said under its answer, already escaped. */
export function turnFooter(p: Pick<ChatLifecycleEvents["turn_ended"], "outcome" | "stop" | "error">): string {
  if (p.outcome === "failed") {
    return `⚠️ ${escapeTelegramHtml(redactForTelegram(truncateText(p.error || "The turn failed.", 500)))}`;
  }
  if (p.outcome === "stopped") {
    const title = p.stop ? describeTurnStop(p.stop).title : "Stopped.";
    return `⏹ ${escapeTelegramHtml(redactForTelegram(title))}`;
  }
  return "";
}
