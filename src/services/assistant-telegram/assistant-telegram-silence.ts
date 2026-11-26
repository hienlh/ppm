/**
 * "Quiet while I'm at PPM": what the bridge sends to Telegram while the user is sitting at PPM goes
 * out without a sound (`disable_notification`), because PPM is already showing it to them.
 *
 * - **At PPM** means a message was typed in PPM, or a PPM tab saw real input, within
 *   {@link QUIET_WINDOW_MS} (five minutes). Presence is the browser's throttled `presence:input`
 *   (at most one a minute), so the window is never shorter than that resolution.
 * - **A card that needs a decision** sent silently gets one reminder with a sound if nobody has
 *   answered it in time (`assistant-telegram-card-reminders.ts`: its own switch and delay, one
 *   message for cards due together, held through quiet hours).
 * - **The switch** is one persistent setting (`clawbot.quiet_while_in_ppm`, on unless set to
 *   false) changed from Settings, from `/quiet` on Telegram and from the Assistant window; every
 *   change goes out as {@link QUIET_CHANGED_EVENT} on `/ws/global` so the three agree. Off, the
 *   bridge sends everything with a sound, as it did before the switch existed.
 *
 * Messages answering something done on Telegram (`/status`, `/sessions`, a pressed button) and the
 * answer to a message typed on Telegram are not this module's business: the user is on the phone.
 * An `urgent` manager card rings whatever this says (`assistant-telegram-manager-cards.ts`).
 */
import { configService } from "../config.service.ts";
import { presenceTracker } from "../presence-tracker.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { DEMO_QUIET_MS } from "./assistant-telegram-card-reminders.ts";
import type { PPMBotConfig } from "../../types/config.ts";
import { QUIET_CHANGED_EVENT } from "../../shared/assistant-telegram-quiet.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

const DEFAULT_QUIET_WINDOW_MS = 5 * 60_000;

/** How long after the last sign of the user at PPM they still count as there (`PPM_TELEGRAM_QUIET_MS` in a demo). */
export const QUIET_WINDOW_MS = DEMO_QUIET_MS ?? DEFAULT_QUIET_WINDOW_MS;

export { QUIET_CHANGED_EVENT };

export { CardReminders, REMINDER_HTML, type CardRemindersDeps, type ReminderRequest } from "./assistant-telegram-card-reminders.ts";

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
