/**
 * The pinned card desk: one message per Telegram chat that lists every card still waiting on the
 * user and shows one of them whole, with its own buttons, so cards stop scrolling out of sight.
 * It is pinned once and then only edited (an edit never rings; a new card still arrives as its
 * own message, with its sound). What it says is drawn in `assistant-telegram-cards-desk-draw.ts`.
 *
 * - **Sources**: every module that puts a waiting card on the phone also `put`s it here once
 *   Telegram has the card's message, and `remove`s it when the card ends. An entry is also asked
 *   `stillWaiting()` at every draw, so one whose end nobody reported still leaves.
 * - **Redraws** go through the chat's send lane under one key, so a burst of changes is one edit,
 *   drawn from the cards as they are when it runs. A draw identical to the last one is skipped.
 * - **Buttons**: a card's answer buttons are its own codes (kept alive while listed, past their
 *   usual day); the desk's own buttons (numbers, ‹ ›, Go to the card) are minted per draw and the
 *   previous draw's are dropped, so a press on an older version says it is no longer valid.
 * - **Restarts**: the message id is kept (`assistant-telegram-cards-desk-store.ts`); on start the
 *   cards that survive a restart are put back (`restore`) and the same message is edited. A desk
 *   the user deleted is sent again and pinned again.
 * - **A send that may have arrived** is not sent again (`ifMaybeSent: "drop"` in spirit): its
 *   codes are dropped, so if it did arrive its buttons answer "no longer valid", and the next
 *   change sends a fresh desk.
 * - **Switched off** (`clawbot.card_desk`): nothing is sent; a desk already pinned is unpinned and
 *   says it is off.
 * - **A reply to the desk** is matched against the versions of the desk the user could have seen
 *   while writing it (every version Telegram confirmed is kept, per desk message), never against the
 *   desk as it is now (`assistant-telegram-cards-desk-reply.ts`). Not certain, the words are kept and
 *   the user is asked which card they answer: they are never dropped.
 * - **Edits are paced by what changed**: a card that stopped waiting leaves within about a second
 *   (`removeDelayMs`, so a burst of ends is still one edit); a new card waits a few seconds for the
 *   next change (`debounceMs`, at most `maxWaitMs`); two edits keep `minGapMs` apart. What the user
 *   does on the desk itself is drawn at once. The desk does not hold still while the user writes:
 *   a reply is matched against the versions they saw, so an edit meanwhile cannot misroute it.
 * - **Rate limits**: an edit refused with a 429 is not repeated with the words it carried; the lane
 *   waits Telegram's `retry_after` and the draw that follows reads the cards as they are by then.
 */
import type { AssistantClock, Cancel } from "../assistant-wake/assistant-clock.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import type { InlineKeyboardMarkup } from "../telegram/telegram-types.ts";
import type { TelegramBotClient } from "../telegram/telegram-bot-client.ts";
import type { BridgeAction, DeskPress } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import {
  drawDesk, jumpHtml, MOVED_DESK_HTML, OFF_DESK_HTML, sortEntries, type DeskEntry,
} from "./assistant-telegram-cards-desk-draw.ts";
import { cardDeskEnabled, memoryCardDeskStore, type CardDeskStore } from "./assistant-telegram-cards-desk-store.ts";
import { BUTTON_URL_INVALID, outcomeOf, sendMessageTask, type AssistantTelegramSendQueue, type TaskOutcome } from "./assistant-telegram-send-queue.ts";
import { createLogger } from "../logger.ts";
import { resolveDeskReply, type DeskReplyInput, type DeskSnapshot } from "./assistant-telegram-cards-desk-reply.ts";
import { entryLine } from "./assistant-telegram-cards-desk-draw.ts";
import { stripTelegramHtml } from "../telegram/telegram-html-format.ts";

const log = createLogger("assistant-telegram");

/** How often ages are brought up to date and the listed cards' codes renewed. */
export const DESK_TICK_MS = 5 * 60_000;
/** A desk not edited for this long is drawn again, so its own buttons are minted again within their day. */
const DESK_REMINT_MS = 12 * 60 * 60_000;
/** A press on the desk this long before it moved to another card made the move: the user saw it. */
const PRESS_SEEN_MS = 15_000;
const EDIT_NOT_FOUND = /message to edit not found/i;
const EDIT_REFUSED = /message can't be edited/i;
/** Desk versions kept per desk message, and desk messages kept per process (oldest dropped first). */
const SNAPSHOTS_PER_DESK = 40;
const DESKS_REMEMBERED = 200;
/** Versions older than this cannot be what a reply arriving now was written against. */
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;

/** How the desk paces its own edits; tests set every value to 0. */
export interface DeskTiming {
  /** A new or changed card waits this long for the next change, so a burst is one edit. */
  debounceMs: number;
  /** However often cards keep coming, a pending change goes out within this long of the first. */
  maxWaitMs: number;
  /**
   * A card that stopped waiting (answered, withdrawn) leaves within this long: an answered card
   * still listed reads as a question nobody took. Short, so several ending together are one edit.
   */
  removeDelayMs: number;
  /** Two edits the desk makes by itself are at least this far apart (Telegram's pace for a chat). */
  minGapMs: number;
}

export const DESK_TIMING: DeskTiming = { debounceMs: 3_000, maxWaitMs: 5_000, removeDelayMs: 300, minGapMs: 1_000 };

/** Where a reply to a desk goes: a card's own message, or a question with the cards to choose from. */
export type DeskReplyRoute =
  | { to: number; key: string; why: string }
  | { ask: Array<{ key: string; label: string }>; ended: string[] };


export interface CardsDeskDeps {
  queue: AssistantTelegramSendQueue;
  codes: ButtonCodes<BridgeAction>;
  store?: CardDeskStore;
  enabled?: () => boolean;
  clock?: AssistantClock;
  /** The cards that outlive a restart (a manager's open cards), put back for this chat. */
  restore?: (chatId: string) => Promise<void>;
  timing?: Partial<DeskTiming>;
}

interface ChatDesk {
  current: string | null;
  /** The card the phone shows whole, as Telegram confirmed it. */
  shown: string | null;
  /**
   * A press on the desk's message (its own buttons or a card's) not yet followed by a move to
   * another card: the next move, if it comes within a few seconds, is the one the press made. Spent
   * by that move, so a later move the desk makes by itself is never taken for the user's.
   */
  pressPending: number;
  /** When the message was last edited or sent. */
  drawnAt: number;
  /** Where the current card sat, so the next one takes its place when it is answered. */
  index: number;
  /** The desk's own buttons of the last draw. */
  group: string | null;
  seq: number;
  /** What the message says now, so an identical draw is skipped. */
  drawn: string | null;
  /** A change waiting to be drawn: when the first one came, and the timer that draws it. */
  pendingSince: number;
  timer: Cancel | null;
  /** When that timer fires; a card ending never pushes it later. */
  dueAt: number;
  /** A card stopped waiting since the last draw: the pending draw keeps the short delay. */
  removal: boolean;
}

export class AssistantTelegramCardsDesk {
  private readonly entries = new Map<string, Map<string, DeskEntry>>();
  private readonly desks = new Map<string, ChatDesk>();
  private readonly store: CardDeskStore;
  private readonly clock: AssistantClock;
  private tick: Cancel | null = null;
  private stopped = false;
  /** Every version of every desk message Telegram confirmed, as `chat:message`, oldest first. */
  private readonly history = new Map<string, DeskSnapshot[]>();
  private readonly timing: DeskTiming;
  /** Chats whose surviving cards were put back since this process started. */
  private readonly restored = new Set<string>();
  private known: string[] = [];

  constructor(private readonly deps: CardsDeskDeps) {
    this.store = deps.store ?? memoryCardDeskStore();
    this.clock = deps.clock ?? assistantClock;
    this.timing = { ...DESK_TIMING, ...deps.timing };
  }

  private enabled(): boolean {
    try { return (this.deps.enabled ?? cardDeskEnabled)(); } catch { return false; }
  }

  private desk(chatId: string): ChatDesk {
    let d = this.desks.get(chatId);
    if (!d) this.desks.set(chatId, d = { current: null, shown: null, pressPending: 0, drawnAt: 0, index: 0, group: null, seq: 0, drawn: null, pendingSince: 0, timer: null, dueAt: 0, removal: false });
    return d;
  }

  /** Puts back what survives a restart (only while the desk is on) and brings every desk up to date; then ticks. */
  async start(chats: string[]): Promise<void> {
    this.known = chats;
    await this.restoreAll();
    if (this.stopped) return;
    for (const chatId of new Set([...this.store.chats(), ...chats])) this.changed(chatId, { now: true });
    this.armTick();
  }

  /**
   * The cards that survive a restart, minted fresh buttons only when the desk is on: off, they would
   * take room in the shared code store for buttons nobody sees.
   */
  private async restoreAll(): Promise<void> {
    if (!this.enabled() || !this.deps.restore) return;
    for (const chatId of new Set([...this.store.chats(), ...this.known])) {
      if (this.restored.has(chatId)) continue;
      this.restored.add(chatId);
      try { await this.deps.restore(chatId); } catch (e) { log.warn(`card desk for chat ${chatId}: cards not restored: ${(e as Error).message}`); }
      if (this.stopped) return;
    }
  }

  stop(): void {
    this.stopped = true;
    this.tick?.();
    this.tick = null;
    for (const d of this.desks.values()) { d.timer?.(); d.timer = null; }
  }

  /** A card on the phone that waits on the user. */
  put(chatId: string, entry: DeskEntry): void {
    let chat = this.entries.get(chatId);
    if (!chat) this.entries.set(chatId, chat = new Map());
    chat.set(entry.key, entry);
    this.changed(chatId);
  }

  remove(chatId: string, key: string): void {
    if (this.entries.get(chatId)?.delete(key)) this.changed(chatId, { removal: true });
  }

  /** The card is gone from every chat. */
  removeEverywhere(key: string): void {
    for (const chatId of this.entries.keys()) this.remove(chatId, key);
  }

  has(chatId: string, key: string): boolean {
    return this.entries.get(chatId)?.has(key) ?? false;
  }

  /** The desk's message in this chat, once it is there and the desk is on. */
  messageOf(chatId: string): number | null {
    return this.enabled() ? this.store.get(chatId) : null;
  }

  /**
   * Where a reply to one of this chat's desk messages (the current one, or one `/cards` moved down)
   * goes: the card's own message, which every module that takes words for a card already knows, or
   * a question listing the cards. Null when the message was never a desk.
   */
  replyFor(chatId: string, messageId: number, input: DeskReplyInput): DeskReplyRoute | null {
    const history = this.history.get(`${chatId}:${messageId}`);
    if (!history && messageId !== this.messageOf(chatId)) return null;
    const waiting = this.waiting(chatId);
    const decision = resolveDeskReply(history ?? [], waiting.map((e) => ({ key: e.key, answers: e.answers ?? [] })), input);
    if ("to" in decision) {
      const target = this.cardMessage(chatId, decision.to);
      if (target !== null) return { to: target, key: decision.to, why: decision.why };
    }
    const ask = "ask" in decision ? decision.ask : waiting.map((e) => e.key);
    const lines = new Map((history ?? []).flatMap((s) => s.lines.map((l) => [l.key, l.text] as const)));
    return {
      ask: ask.map((key) => ({ key, label: this.label(chatId, key) ?? lines.get(key) ?? "A card" })),
      ended: ("ended" in decision ? decision.ended : []).map((key) => lines.get(key)).filter((t): t is string => !!t),
    };
  }

  /** A waiting card's own message in this chat; null when it no longer waits or has none. */
  cardMessage(chatId: string, key: string): number | null {
    const e = this.waiting(chatId).find((x) => x.key === key);
    return e?.messageId ?? null;
  }

  /** "🔐 nxsys · Release 0.26.40: Bash", plain, as a button names a card. */
  private label(chatId: string, key: string): string | null {
    const e = this.entries.get(chatId)?.get(key);
    if (!e) return null;
    return [e.icon, e.project?.trim() ? `${e.project.trim()} ·` : "", e.title.replace(/\s+/g, " ").trim()].filter(Boolean).join(" ");
  }

  /**
   * A button on this chat's desk message was pressed (one of the desk's or a card's): the user is
   * looking at it. True when the message is the desk, so the caller redraws it after the press —
   * a card's handler may have edited the desk's buttons as if they were the card's own.
   */
  pressedOn(chatId: string, messageId: number | undefined): boolean {
    if (messageId === undefined || messageId !== this.messageOf(chatId)) return false;
    this.desk(chatId).pressPending = this.clock.now();
    return true;
  }

  /** Draws the desk again at once, even if nothing seems to have changed (after a press on it). */
  redraw(chatId: string): void {
    const d = this.desks.get(chatId);
    if (d) d.drawn = null;
    this.changed(chatId, { now: true });
  }

  forgetChat(chatId: string): void {
    const d = this.desks.get(chatId);
    d?.timer?.();
    if (d?.group) this.deps.codes.dropGroup(d.group);
    for (const key of [...this.history.keys()]) if (key.startsWith(`${chatId}:`)) this.history.delete(key);
    this.desks.delete(chatId);
    this.entries.delete(chatId);
    this.store.set(chatId, null);
  }

  /** The cards waiting in this chat, in the desk's order; ended ones are dropped on the way. */
  waiting(chatId: string): DeskEntry[] {
    const chat = this.entries.get(chatId);
    if (!chat) return [];
    for (const [key, e] of chat) {
      let alive = false;
      try { alive = e.stillWaiting(); } catch { /* unreadable: not waiting */ }
      if (!alive) chat.delete(key);
    }
    return sortEntries([...chat.values()]);
  }

  /**
   * Something on the desk may have changed. Drawn at once when the user is acting on the desk
   * (`now`, or a press on it moments ago); a card that stopped waiting (`removal`) within
   * `removeDelayMs`; anything else after `debounceMs` (`DeskTiming`).
   */
  changed(chatId: string, opts: { now?: boolean; removal?: boolean } = {}): void {
    if (this.stopped) return;
    const d = this.desk(chatId);
    const pressed = d.pressPending > 0 && this.clock.now() - d.pressPending <= PRESS_SEEN_MS;
    if (opts.now || pressed) {
      this.clearPending(d);
      this.enqueueDraw(chatId);
      return;
    }
    if (!d.pendingSince) d.pendingSince = this.clock.now();
    if (opts.removal) d.removal = true;
    this.schedule(chatId, d);
  }

  private clearPending(d: ChatDesk): void {
    d.timer?.();
    d.timer = null;
    d.pendingSince = 0;
    d.removal = false;
  }

  /**
   * (Re)sets the timer of a paced change. A new card pushes it back to `debounceMs` from now, up to
   * `maxWaitMs` from the first change; a removal brings it forward to `removeDelayMs`, and nothing
   * moves a removal's draw later.
   */
  private schedule(chatId: string, d: ChatDesk): void {
    const now = this.clock.now();
    const t = this.timing;
    const gap = d.drawnAt + t.minGapMs;
    let at = d.removal
      ? Math.max(now + t.removeDelayMs, gap)
      : Math.min(Math.max(now + t.debounceMs, gap), d.pendingSince + t.maxWaitMs);
    if (d.removal && d.timer) at = Math.min(at, d.dueAt);
    d.timer?.();
    d.timer = null;
    if (at <= now) {
      this.clearPending(d);
      this.enqueueDraw(chatId);
      return;
    }
    d.dueAt = at;
    d.timer = this.clock.setTimer(() => {
      this.clearPending(d);
      if (!this.stopped) this.enqueueDraw(chatId);
    }, at - now);
  }

  private enqueueDraw(chatId: string): void {
    let attempts = 0;
    this.deps.queue.enqueue(chatId, {
      key: `card-desk:${chatId}`, final: true, label: "card desk",
      run: async (client) => this.draw(client, chatId, ++attempts),
    });
  }

  /** A press on one of the desk's own buttons; the toast to show. */
  press(chatId: string, press: DeskPress, group: string): string {
    const d = this.desks.get(chatId);
    if (!d || d.group !== group) return "This list has changed — use the newest one.";
    d.pressPending = this.clock.now();
    const list = this.waiting(chatId);
    const at = list.findIndex((e) => e.key === d.current);
    if (press.op === "jump") {
      const e = list.find((x) => x.key === press.key);
      if (!e || e.messageId === null) return "This card is no longer waiting.";
      this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
        html: `👆 ${jumpHtml(e)}`, replyTo: e.messageId,
      }, { label: "card desk jump", silent: true, ifMaybeSent: "drop" }));
      return "Tap the quote to go to the card.";
    }
    if (!list.length) return "Nothing is waiting.";
    let next: number;
    if (press.op === "show") next = list.findIndex((e) => e.key === press.key);
    else if (press.op === "next") next = (Math.max(at, 0) + 1) % list.length;
    else next = (Math.max(at, 0) - 1 + list.length) % list.length;
    if (next < 0) return "This card is no longer waiting.";
    d.current = list[next]!.key;
    d.index = next;
    this.changed(chatId, { now: true });
    return `${next + 1} of ${list.length}`;
  }

  /**
   * `/cards`: the desk again at the bottom of the chat, pinned there; the old one is unpinned and
   * says where it went. What to reply, or null when the new desk is the answer.
   */
  resend(chatId: string): string | null {
    if (!this.enabled()) return OFF_DESK_HTML;
    if (!this.waiting(chatId).length) return "✅ Nothing is waiting for you.";
    const old = this.store.get(chatId);
    if (old !== null) {
      this.store.set(chatId, null);
      this.retire(chatId, old, MOVED_DESK_HTML);
    }
    this.desk(chatId).drawn = null;
    this.changed(chatId, { now: true });
    return null;
  }

  private armTick(): void {
    if (this.stopped) return;
    this.tick = this.clock.setTimer(() => {
      this.tick = null;
      this.onTick();
      this.armTick();
    }, DESK_TICK_MS);
  }

  /** The switch moved: a desk goes up where cards wait, or comes down everywhere. */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    try { await this.restoreAll(); } catch { /* each chat already logged its own */ }
    if (!this.stopped) this.onTick();
  }

  /** Ages move, codes need renewing, and a desk switched off is taken down. */
  private onTick(): void {
    const on = this.enabled();
    for (const chatId of new Set([...this.entries.keys(), ...this.store.chats()])) {
      if (!on) {
        // Kept while off, so the desk lists them when it is turned on; ended ones still go.
        this.waiting(chatId);
        const id = this.store.get(chatId);
        if (id !== null) {
          this.store.set(chatId, null);
          this.desk(chatId).drawn = null;
          this.retire(chatId, id, OFF_DESK_HTML);
        }
        continue;
      }
      for (const e of this.waiting(chatId)) for (const g of e.groups) this.deps.codes.renewGroup(g);
      const d = this.desks.get(chatId);
      if (d && this.clock.now() - d.drawnAt > DESK_REMINT_MS) d.drawn = null;
      this.changed(chatId);
    }
  }

  /** Unpins an old desk and leaves one line in its place. */
  private retire(chatId: string, messageId: number, html: string): void {
    let attempts = 0;
    this.deps.queue.enqueue(chatId, {
      final: true, label: "card desk retired",
      run: async (client) => {
        await client.unpinChatMessage(chatId, messageId);
        const res = await client.editMessageText(chatId, messageId, html, { final: true });
        if (!res.ok && !("throttled" in res) && (EDIT_NOT_FOUND.test(res.description) || EDIT_REFUSED.test(res.description))) return { kind: "done" };
        return outcomeOf(res, ++attempts);
      },
    });
  }

  private async draw(client: TelegramBotClient, chatId: string, attempts: number): Promise<TaskOutcome> {
    if (this.stopped || !this.enabled()) return { kind: "done" };
    const d = this.desk(chatId);
    const list = this.waiting(chatId);
    let messageId = this.store.get(chatId);
    // Nothing to list and nothing pinned: no desk until a card needs one.
    if (!list.length && messageId === null) return { kind: "done" };

    const prevGroup = d.group;
    const group = `desk:${chatId}:${++d.seq}`;
    /** The desk's own buttons by code, as what they mean: their codes change every draw, their meaning may not. */
    const meaning = new Map<string, string>();
    const drawn = drawDesk(list, d.current, d.index, this.clock.now(), (text, press) => {
      const code = this.deps.codes.mint(chatId, group, { kind: "desk", ...press });
      meaning.set(code, JSON.stringify([text, press]));
      return { text, callback_data: code };
    });
    d.current = drawn.current?.key ?? null;
    d.index = drawn.current ? list.indexOf(drawn.current) : 0;
    const sig = JSON.stringify([drawn.html, drawn.rows.map((r) => r.map((b) => meaning.get(b.callback_data ?? "") ?? b))]);
    if (messageId !== null && sig === d.drawn) {
      this.deps.codes.dropGroup(group);
      return { kind: "done" };
    }
    const markup: InlineKeyboardMarkup = { inline_keyboard: drawn.rows };

    if (messageId !== null) {
      // A 429 comes back here rather than being repeated with this text: the lane waits it out and
      // the next draw reads the cards as they are then.
      let res = await client.editMessageText(chatId, messageId, drawn.html, { replyMarkup: markup, final: true, returnRateLimit: true });
      if (!res.ok && !("throttled" in res) && res.errorCode === 400 && BUTTON_URL_INVALID.test(res.description)) {
        res = await client.editMessageText(chatId, messageId, drawn.html, { replyMarkup: withoutLinks(markup), final: true, returnRateLimit: true });
      }
      if (this.gone(chatId, d)) {
        this.deps.codes.dropGroup(group);
        return { kind: "done" };
      }
      if (res.ok) {
        this.settle(chatId, messageId, d, group, prevGroup, sig, drawn, list);
        return { kind: "done" };
      }
      if (!("throttled" in res) && (EDIT_NOT_FOUND.test(res.description) || EDIT_REFUSED.test(res.description))) {
        // Deleted by the user, or one Telegram will not let the bot edit: a new desk takes its place,
        // and one that still exists is unpinned first so two are never pinned.
        log.info(`card desk for chat ${chatId}: message ${messageId} cannot be edited; sending a new one`);
        if (EDIT_REFUSED.test(res.description)) await client.unpinChatMessage(chatId, messageId);
        this.store.set(chatId, null);
        messageId = null;
      } else {
        this.deps.codes.dropGroup(group);
        return outcomeOf(res, attempts);
      }
    }
    if (!list.length) {
      this.deps.codes.dropGroup(group);
      return { kind: "done" };
    }
    let sent = await client.sendMessage(chatId, drawn.html, { replyMarkup: markup, silent: true });
    if (!sent.ok && sent.errorCode === 400 && BUTTON_URL_INVALID.test(sent.description)) {
      sent = await client.sendMessage(chatId, drawn.html, { replyMarkup: withoutLinks(markup), silent: true });
    }
    if (this.gone(chatId, d)) {
      // Stopped or disconnected meanwhile: nothing is recorded or pinned for a bridge that is gone.
      this.deps.codes.dropGroup(group);
      return { kind: "done" };
    }
    if (!sent.ok) {
      this.deps.codes.dropGroup(group);
      // It may have arrived: a second desk is worse than a late one, and the next change sends anew.
      if ("maybeSent" in sent && sent.maybeSent) {
        return { kind: "failed", why: `Telegram did not answer (${sent.description}); not sent again` };
      }
      return outcomeOf(sent, attempts);
    }
    this.store.set(chatId, sent.result.message_id);
    this.settle(chatId, sent.result.message_id, d, group, prevGroup, sig, drawn, list);
    const pinned = await client.pinChatMessage(chatId, sent.result.message_id);
    if (!pinned.ok) log.warn(`card desk for chat ${chatId}: could not pin it: ${pinned.description}`);
    return { kind: "done" };
  }

  /** The bridge stopped, or the chat was forgotten, while a call to Telegram was out. */
  private gone(chatId: string, d: ChatDesk): boolean {
    return this.stopped || this.desks.get(chatId) !== d;
  }

  /**
   * Telegram has the drawn desk: its buttons are the live ones, and this version is kept, so a reply
   * is matched against what the phone showed rather than what the desk shows by then.
   */
  private settle(
    chatId: string, messageId: number, d: ChatDesk, group: string, prevGroup: string | null, sig: string,
    drawn: { html: string; current: DeskEntry | null }, list: DeskEntry[],
  ): void {
    if (prevGroup && prevGroup !== group) this.deps.codes.dropGroup(prevGroup);
    d.group = group;
    d.drawn = sig;
    const now = this.clock.now();
    d.drawnAt = now;
    const key = drawn.current?.key ?? null;
    const moved = d.shown !== key;
    const byPress = moved && d.pressPending > 0 && now - d.pressPending <= PRESS_SEEN_MS;
    if (moved) d.pressPending = 0;
    d.shown = key;
    this.remember(chatId, {
      messageId, from: now, shown: key, byPress,
      lines: list.map((e, i) => ({ key: e.key, text: stripTelegramHtml(entryLine(e, i + 1, false, now)) })),
      shownText: stripTelegramHtml(drawn.html),
    });
  }

  private remember(chatId: string, snap: DeskSnapshot): void {
    const id = `${chatId}:${snap.messageId}`;
    const kept = (this.history.get(id) ?? []).filter((s) => snap.from - s.from <= SNAPSHOT_MAX_AGE_MS);
    kept.push(snap);
    this.history.delete(id);
    this.history.set(id, kept.slice(-SNAPSHOTS_PER_DESK));
    while (this.history.size > DESKS_REMEMBERED) this.history.delete(this.history.keys().next().value!);
  }
}

function withoutLinks(markup: InlineKeyboardMarkup): InlineKeyboardMarkup {
  return { inline_keyboard: markup.inline_keyboard.map((r) => r.filter((b) => b.url === undefined)).filter((r) => r.length) };
}
