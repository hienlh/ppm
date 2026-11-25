/**
 * Voice messages the bridge is reading or holding for the user's review, in memory only.
 *
 * A voice message owns the bundle it arrived in (the texts and photos gathered with it): while it
 * is being transcribed that bundle stays open, and while its card waits for Send or Cancel the
 * bundle waits with it. A card left unanswered expires with its buttons (a day): its audio is
 * deleted and `onExpire` hears of it, so what came with the voice can still go. After a restart
 * every one is gone, as the buttons are.
 */
import { rmSync } from "node:fs";
import type { InlineKeyboardMarkup } from "../telegram/telegram-types.ts";
import type { TelegramQuote } from "./assistant-telegram-reply-quote.ts";
import { CODE_TTL_MS } from "./assistant-telegram-button-codes.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export type BundleImage = { data: string; mediaType: string };

/**
 * What a chat gathered into one message. `voice`: the id of the voice message that owns it.
 * `words`: the voice answers a card or a task (a reply to one, or the message after ✏️ Other or
 * "Message about this task"), so it is a bundle of its own and its transcript goes where typed
 * words to that message would have gone.
 */
export interface VoiceBundle {
  updateIds: number[];
  parts: string[];
  images: BundleImage[];
  quote: TelegramQuote | null;
  voice?: string;
  words?: VoiceWordsAim;
}

/** The voice message itself, and the bot message it replies to (none after Other or "Message about this task"). */
export interface VoiceWordsAim { messageId: number; replyToMessageId?: number }

export interface VoiceJob {
  id: string;
  chatId: string;
  bundle: VoiceBundle;
  durationSec: number;
  /** The bot message showing this voice message's status, then its card. */
  messageId?: number;
  /** The stored audio, once saved. */
  path?: string;
  /** processing: being read; review: its card waits for Send/Cancel; done: sent or dropped. */
  state: "processing" | "review" | "done";
  /** What the pipeline returned (cleaned, or raw when it could not be), for telling an edit apart. */
  proposed: string;
  transcript: string;
  label: "cleaned" | "raw" | "replaced" | "plain";
  reason?: string;
  /** An audio file (mp3, m4a…) rather than a voice note: its file extension, for the stored copy. */
  audioExt?: string;
  /** What the clean-up replaced and how long each step took, for the card. */
  fixes?: Array<{ from: string; to: string }>;
  timing?: { whisperMs: number; haikuMs?: number };
  /** Words self-learning learned from this message's clean-up, for the "Sent" note. */
  learned?: Array<{ word: string; from: string }>;
  markup?: InlineKeyboardMarkup;
  expiresAt: number;
  /** Wakes the sweep when this card's day is up; cleared when the job ends any other way. */
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export class PendingVoices {
  private readonly jobs = new Map<string, VoiceJob>();

  constructor(private readonly now: () => number, private readonly onExpire?: (job: VoiceJob) => void) {}

  add(job: VoiceJob): void {
    this.prune();
    this.jobs.set(job.id, job);
  }

  get(id: string): VoiceJob | undefined {
    this.prune();
    return this.jobs.get(id);
  }

  /** The card waiting for review that a chat's message `messageId` shows. */
  cardAt(chatId: string, messageId: number): VoiceJob | undefined {
    this.prune();
    for (const job of this.jobs.values()) {
      if (job.chatId === chatId && job.state === "review" && job.messageId === messageId) return job;
    }
    return undefined;
  }

  /** Done with it: `keepAudio` when it was sent (the message names the file). */
  finish(job: VoiceJob, keepAudio: boolean): void {
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    job.expiryTimer = undefined;
    job.state = "done";
    this.jobs.delete(job.id);
    if (!keepAudio) removeAudio(job);
  }

  /** Whether any voice message is still being read. */
  reading(): boolean {
    for (const job of this.jobs.values()) if (job.state === "processing") return true;
    return false;
  }

  forgetChat(chatId: string): void {
    for (const job of [...this.jobs.values()]) if (job.chatId === chatId) this.finish(job, false);
  }

  clear(): void {
    for (const job of [...this.jobs.values()]) this.finish(job, false);
  }

  /** Ends every card nobody answered for a day; also run by each card's own timer. */
  sweep(): void {
    this.prune();
  }

  /** A card nobody answered for a day: its buttons are gone, so it is too — but never silently. */
  private prune(): void {
    const now = this.now();
    for (const job of [...this.jobs.values()]) {
      if (job.state !== "review" || job.expiresAt > now) continue;
      this.finish(job, false);
      this.onExpire?.(job);
    }
  }
}

function removeAudio(job: VoiceJob): void {
  if (!job.path) return;
  try {
    rmSync(job.path, { force: true });
  } catch (e) {
    log.warn(`Could not delete an unsent voice message's audio: ${(e as Error).message}`);
  }
}

/** For a job created now. */
export function voiceExpiry(now: number): number {
  return now + CODE_TTL_MS;
}
