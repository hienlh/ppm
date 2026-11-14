/**
 * "Quiet while I'm at PPM": what the bridge sends to Telegram while the user is sitting at PPM goes
 * out without a sound (`disable_notification`), because PPM is already showing it to them.
 *
 * - **At PPM** means a message was typed in PPM, or a PPM tab saw real input, within
 *   {@link QUIET_WINDOW_MS} (five minutes). Presence is the browser's throttled `presence:input`
 *   (at most one a minute), so the window is never shorter than that resolution.
 * - **A card that needs a decision** sent silently gets one reminder with a sound, as a reply to
 *   the card, if nobody has answered it {@link QUIET_WINDOW_MS} later. Quiet hours win: a reminder
 *   due inside them is not sent. Only one reminder per card message, ever.
 * - **The switch** is one persistent setting (`clawbot.quiet_while_in_ppm`, on unless set to
 *   false) changed from Settings, from `/quiet` on Telegram and from the Assistant window; every
 *   change goes out as {@link QUIET_CHANGED_EVENT} on `/ws/global` so the three agree. Off, the
 *   bridge sends everything with a sound, as it did before the switch existed.
 *
 * Messages answering something done on Telegram (`/status`, `/sessions`, a pressed button) and the
 * answer to a message typed on Telegram are not this module's business: the user is on the phone.
 */
import { configService } from "../config.service.ts";
import { presenceTracker } from "../presence-tracker.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { assistantClock, type AssistantClock, type Cancel } from "../assistant-wake/assistant-clock.ts";
import { currentQuietWindowEnd } from "../assistant-wake/wake-quiet-hours.ts";
import type { PPMBotConfig } from "../../types/config.ts";
import { QUIET_CHANGED_EVENT } from "../../shared/assistant-telegram-quiet.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

const DEFAULT_QUIET_WINDOW_MS = 5 * 60_000;

/**
 * Read once, at module load: the demo and an e2e set `PPM_TELEGRAM_QUIET_MS` before the server
 * starts so "away for five minutes" is reachable in seconds. Unit tests inject their own numbers.
 */
function windowFromEnv(): number {
  const raw = process.env.PPM_TELEGRAM_QUIET_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUIET_WINDOW_MS;
}

/** How long after the last sign of the user at PPM they still count as there; also a card's reminder delay. */
export const QUIET_WINDOW_MS = windowFromEnv();

export { QUIET_CHANGED_EVENT };

export const REMINDER_HTML = "⏰ <b>Still waiting for you</b>: nobody has answered the card above yet.";

/** The switch as stored; on unless explicitly turned off. */
export function quietWhileInPpm(): boolean {
  const c = configService.get("clawbot") as Partial<PPMBotConfig> | undefined;
  return c?.quiet_while_in_ppm !== false;
}

/**
 * Turns the switch on or off, keeping the rest of the row, and tells every PPM tab. Returns the
 * value now stored. Throws when the config cannot be written (an unloaded config refuses to save).
 */
export function setQuietWhileInPpm(on: boolean): boolean {
  const current = (configService.get("clawbot") as Partial<PPMBotConfig> | undefined) ?? {};
  configService.set("clawbot", { ...current, quiet_while_in_ppm: on } as PPMBotConfig);
  log.info(`Quiet while at PPM turned ${on ? "on" : "off"}`);
  try {
    broadcastGlobalEvent({ type: QUIET_CHANGED_EVENT, on });
  } catch (e) {
    log.warn(`could not announce the quiet switch: ${(e as Error).message}`);
  }
  return on;
}

export interface TelegramSilenceDeps {
  /** The switch. */
  enabled(): boolean;
  /** Milliseconds since a PPM tab last saw real input; null when none has since the server started. */
  idleMs(now: number): number | null;
  now(): number;
  windowMs?: number;
}

const realSilenceDeps: TelegramSilenceDeps = {
  enabled: quietWhileInPpm,
  idleMs: (now) => presenceTracker.presence(now).idleMs,
  now: () => Date.now(),
};

/** Whether the user is at PPM, and so whether the bridge sends without a sound. */
export class TelegramSilence {
  private lastPpmMessageAt: number | null = null;
  private readonly windowMs: number;

  constructor(private readonly deps: TelegramSilenceDeps = realSilenceDeps) {
    this.windowMs = deps.windowMs ?? QUIET_WINDOW_MS;
  }

  /** The switch is on. */
  enabled(): boolean {
    try {
      return this.deps.enabled();
    } catch {
      return false;
    }
  }

  /** A message was typed in PPM: the user is there, whatever presence has heard so far. */
  notePpmMessage(at: number = this.deps.now()): void {
    this.lastPpmMessageAt = at;
  }

  /** The switch is on and the user typed in PPM or touched a PPM tab within the window. */
  inPpm(): boolean {
    if (!this.enabled()) return false;
    const now = this.deps.now();
    let idle: number | null = null;
    try { idle = this.deps.idleMs(now); } catch { /* unknown: only the typed message counts */ }
    const sinceTyped = this.lastPpmMessageAt === null ? null : now - this.lastPpmMessageAt;
    const nearest = Math.min(idle ?? Infinity, sinceTyped ?? Infinity);
    return nearest <= this.windowMs;
  }
}

export interface CardRemindersDeps {
  queue: AssistantTelegramSendQueue;
  clock?: AssistantClock;
  /** When the quiet window now running ends; null outside quiet hours. */
  quietEnd?: () => number | null;
  delayMs?: number;
}

export interface ReminderRequest {
  chatId: string;
  /** The card's message: the reminder is a reply to it. */
  messageId: number;
  /** Whether the card still waits for an answer when the reminder is due. */
  stillWaiting: () => boolean;
  /** What the card is, for the log. */
  label: string;
}

/** One reminder with a sound for a card sent silently that nobody answered in time. */
export class CardReminders {
  private readonly timers = new Map<string, Cancel>();
  /** Card messages already reminded about (or due to be), so none is reminded twice. */
  private readonly seen = new Set<string>();
  private readonly clock: AssistantClock;
  private readonly quietEnd: () => number | null;
  private readonly delayMs: number;

  constructor(private readonly deps: CardRemindersDeps) {
    this.clock = deps.clock ?? assistantClock;
    this.quietEnd = deps.quietEnd ?? currentQuietWindowEnd;
    this.delayMs = deps.delayMs ?? QUIET_WINDOW_MS;
  }

  schedule(req: ReminderRequest): void {
    const key = `${req.chatId}:${req.messageId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    this.timers.set(key, this.clock.setTimer(() => {
      this.timers.delete(key);
      this.fire(req);
    }, this.delayMs));
  }

  /** Drops every pending reminder (the bridge stopped). */
  clear(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  /** Pending reminders, for tests. */
  pending(): number {
    return this.timers.size;
  }

  private fire(req: ReminderRequest): void {
    let waiting = false;
    try { waiting = req.stillWaiting(); } catch { /* unknown: no reminder */ }
    if (!waiting) return;
    let quiet: number | null = null;
    try { quiet = this.quietEnd(); } catch { /* unreadable: outside quiet hours */ }
    if (quiet !== null) {
      log.info(`${req.label} in Telegram chat ${req.chatId}: no reminder in quiet hours`);
      return;
    }
    this.deps.queue.enqueue(req.chatId, sendMessageTask(this.deps.queue, req.chatId, {
      html: REMINDER_HTML, replyTo: req.messageId,
    }, { label: `${req.label} reminder` }));
  }
}
