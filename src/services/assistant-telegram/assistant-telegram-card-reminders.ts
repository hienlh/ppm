/**
 * The reminder for a card sent to Telegram without a sound (the user was at PPM) that nobody has
 * answered since.
 *
 * - **Once per card, ever.** A card message is reminded about at most one time, `delay` after it
 *   was sent (`clawbot.card_reminder_minutes`, 5 by default). No backoff ladder: a card that still
 *   waits after one nudge is listed by `/status` and the morning digest, which is where it belongs.
 * - **One message for cards due together.** When the first card of a chat comes due, every other
 *   card of that chat due within {@link GATHER_MS} (at most half its delay) goes in the same message: a list with each card's
 *   project and title, each a link into PPM when PPM has a public address. A single card keeps
 *   the old form, a reply to the card itself, so tapping it jumps there.
 * - **Quiet hours** hold the reminder until they end, then send one message for whatever still
 *   waits; a card answered or withdrawn meanwhile is left out, and nothing is sent if none is left.
 * - **The switch** (`clawbot.card_reminders`, on unless false) is read when a card is sent and
 *   again when its reminder is due, so turning it off drops what is pending.
 * - **Never sent twice by a slow Telegram.** The reminder is sent with `ifMaybeSent: "drop"`: if
 *   Telegram does not answer, it is not sent again, because it may have arrived. One reminder was
 *   once delivered five times while Telegram was timing out.
 */
import { configService } from "../config.service.ts";
import { assistantClock, type AssistantClock, type Cancel } from "../assistant-wake/assistant-clock.ts";
import { currentQuietWindowEnd } from "../assistant-wake/wake-quiet-hours.ts";
import type { PPMBotConfig } from "../../types/config.ts";
import { CARD_REMINDER_MINUTES, validReminderMinutes } from "../../shared/assistant-telegram-card-reminders.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import { isPublicHttpsUrl } from "./assistant-telegram-links.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/**
 * A card coming due this long after the first one of its chat goes in the same message, but never
 * more than half its own delay early: with a 1-minute delay, a card sent seconds ago is not nudged.
 */
export const GATHER_MS = 3 * 60_000;
/** Lines listed in one reminder; the rest are counted. */
export const REMINDER_LIST_MAX = 10;
const TITLE_MAX = 80;

/**
 * Read once at module load: the demo and an e2e set `PPM_TELEGRAM_QUIET_MS` before the server
 * starts so "away for five minutes" is reachable in seconds. It then overrides the setting.
 */
function envDelayMs(): number | null {
  const raw = process.env.PPM_TELEGRAM_QUIET_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** `PPM_TELEGRAM_QUIET_MS` when set: the quiet window and the reminder delay both. */
export const DEMO_QUIET_MS = envDelayMs();

export const REMINDER_HTML = "⏰ <b>Still waiting for you</b>: nobody has answered the card above yet.";

export interface CardReminderSettings {
  enabled: boolean;
  minutes: number;
}

/** The settings as stored: on, after 5 minutes, unless set otherwise. */
export function cardReminderSettings(): CardReminderSettings {
  const c = configService.get("clawbot") as Partial<PPMBotConfig> | undefined;
  return {
    enabled: c?.card_reminders !== false,
    minutes: validReminderMinutes(c?.card_reminder_minutes) ?? CARD_REMINDER_MINUTES.default,
  };
}

export interface CardRemindersDeps {
  queue: AssistantTelegramSendQueue;
  clock?: AssistantClock;
  /** When the quiet window now running ends; null outside quiet hours. */
  quietEnd?: () => number | null;
  /** Fixed delay (tests); otherwise `PPM_TELEGRAM_QUIET_MS`, otherwise the setting. */
  delayMs?: number;
  /** The settings; tests stand in for the config. */
  settings?: () => CardReminderSettings;
}

export interface ReminderRequest {
  chatId: string;
  /** The card's message: a single reminder replies to it. */
  messageId: number;
  /** Whether the card still waits for an answer when the reminder is due. */
  stillWaiting: () => boolean;
  /** What the card is, for the log. */
  label: string;
  /** The card's project, shown before its title in a list. */
  project?: string | null;
  /** A short title for the list; plain text, escaped here. */
  title?: string;
  /** Where the card is in PPM; a list line links to it when Telegram can open it. */
  url?: string | null;
}

interface Due { req: ReminderRequest; dueAt: number; delay: number }

/** The reminder for cards nobody answered: one per card, one message for those due together. */
export class CardReminders {
  /** Cards waiting for their reminder, per Telegram chat, by card message. */
  private readonly due = new Map<string, Map<string, Due>>();
  /** One timer per chat, set for the earliest card due there (or the end of quiet hours). */
  private readonly timers = new Map<string, { at: number; cancel: Cancel }>();
  /** Card messages already reminded about (or due to be), so none is reminded twice. */
  private readonly seen = new Set<string>();
  private readonly clock: AssistantClock;
  private readonly quietEnd: () => number | null;
  private readonly settings: () => CardReminderSettings;

  constructor(private readonly deps: CardRemindersDeps) {
    this.clock = deps.clock ?? assistantClock;
    this.quietEnd = deps.quietEnd ?? currentQuietWindowEnd;
    this.settings = deps.settings ?? cardReminderSettings;
  }

  schedule(req: ReminderRequest): void {
    const settings = this.readSettings();
    if (!settings.enabled) return;
    const key = `${req.chatId}:${req.messageId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    const delay = this.deps.delayMs ?? DEMO_QUIET_MS ?? settings.minutes * 60_000;
    const dueAt = this.clock.now() + delay;
    let chat = this.due.get(req.chatId);
    if (!chat) this.due.set(req.chatId, chat = new Map());
    chat.set(key, { req, dueAt, delay });
    this.arm(req.chatId, dueAt);
  }

  /** Drops every pending reminder (the bridge stopped). */
  clear(): void {
    for (const t of this.timers.values()) t.cancel();
    this.timers.clear();
    this.due.clear();
  }

  /** Cards waiting for their reminder, for tests. */
  pending(): number {
    let n = 0;
    for (const chat of this.due.values()) n += chat.size;
    return n;
  }

  private readSettings(): CardReminderSettings {
    try {
      return this.settings();
    } catch {
      return { enabled: true, minutes: CARD_REMINDER_MINUTES.default };
    }
  }

  /** Makes sure the chat's timer goes off no later than `at`. */
  private arm(chatId: string, at: number): void {
    const current = this.timers.get(chatId);
    if (current && current.at <= at) return;
    current?.cancel();
    const cancel = this.clock.setTimer(() => {
      this.timers.delete(chatId);
      this.flush(chatId);
    }, Math.max(0, at - this.clock.now()));
    this.timers.set(chatId, { at, cancel });
  }

  private flush(chatId: string): void {
    const chat = this.due.get(chatId);
    if (!chat?.size) return void this.due.delete(chatId);
    if (!this.readSettings().enabled) {
      log.info(`Telegram chat ${chatId}: card reminders are off, ${chat.size} pending dropped`);
      this.due.delete(chatId);
      return;
    }
    const now = this.clock.now();
    let quiet: number | null = null;
    try { quiet = this.quietEnd(); } catch { /* unreadable: outside quiet hours */ }
    if (quiet !== null) {
      log.info(`Telegram chat ${chatId}: ${chat.size} card reminder(s) held until quiet hours end`);
      // Never sooner than a minute: a window that says it ends now must not spin the timer.
      this.arm(chatId, Math.max(quiet, now + 60_000));
      return;
    }
    const ready: Due[] = [];
    for (const [key, d] of chat) {
      if (d.dueAt - now > Math.min(GATHER_MS, d.delay / 2)) continue;
      ready.push(d);
      chat.delete(key);
    }
    const waiting = ready.filter((d) => {
      try { return d.req.stillWaiting(); } catch { return false; }
    }).sort((a, b) => a.dueAt - b.dueAt);
    if (waiting.length) this.send(chatId, waiting.map((d) => d.req));
    if (chat.size) this.arm(chatId, Math.min(...[...chat.values()].map((d) => d.dueAt)));
    else this.due.delete(chatId);
  }

  private send(chatId: string, cards: ReminderRequest[]): void {
    const single = cards.length === 1;
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, single
      ? { html: REMINDER_HTML, replyTo: cards[0]!.messageId }
      : { html: reminderListHtml(cards) }, {
      label: single ? `${cards[0]!.label} reminder` : `reminder for ${cards.length} cards`,
      // A reminder that may have arrived is not sent again: a duplicate costs more than a lost nudge.
      ifMaybeSent: "drop",
    }));
  }
}

/** One message for several cards still waiting: a line each, linked into PPM where Telegram can open it. */
export function reminderListHtml(cards: ReminderRequest[]): string {
  const lines = cards.slice(0, REMINDER_LIST_MAX).map((c) => `• ${reminderLine(c)}`);
  const more = cards.length - REMINDER_LIST_MAX;
  if (more > 0) lines.push(`…and ${more} more in PPM`);
  return [`⏰ <b>Still waiting for you: ${cards.length} cards</b>`, "Nobody has answered these yet:", ...lines].join("\n");
}

function reminderLine(card: ReminderRequest): string {
  const clean = (s: string) => truncateText(redactForTelegram(s.replace(/\s+/g, " ").trim()), TITLE_MAX);
  const title = clean(card.title ?? "") || "A card";
  const project = card.project ? clean(card.project) : "";
  const text = escapeTelegramHtml(project ? `${project} · ${title}` : title);
  return card.url && isPublicHttpsUrl(card.url) ? `<a href="${escapeTelegramHtml(card.url)}">${text}</a>` : text;
}
