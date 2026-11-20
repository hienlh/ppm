/**
 * Voice messages the bridge is reading or holding for the user's review, in memory only.
 *
 * A voice message owns the bundle it arrived in (the texts and photos gathered with it): while it
 * is being transcribed that bundle stays open, and while its card waits for Send or Cancel the
 * bundle waits with it. A card left unanswered expires with its buttons (a day); after a restart
 * every one is gone, as the buttons are, and its stored audio is deleted with it.
 */
import { rmSync } from "node:fs";
import type { InlineKeyboardMarkup } from "../telegram/telegram-types.ts";
import type { TelegramQuote } from "./assistant-telegram-reply-quote.ts";
import { CODE_TTL_MS } from "./assistant-telegram-button-codes.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export type BundleImage = { data: string; mediaType: string };

/** What a chat gathered into one message. `voice`: the id of the voice message that owns it. */
export interface VoiceBundle {
  updateIds: number[];
  parts: string[];
  images: BundleImage[];
  quote: TelegramQuote | null;
  voice?: string;
}

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
  label: "cleaned" | "raw" | "replaced";
  reason?: string;
  markup?: InlineKeyboardMarkup;
  expiresAt: number;
}

export class PendingVoices {
  private readonly jobs = new Map<string, VoiceJob>();

  constructor(private readonly now: () => number) {}

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
    job.state = "done";
    this.jobs.delete(job.id);
    if (!keepAudio) removeAudio(job);
  }

  forgetChat(chatId: string): void {
    for (const job of [...this.jobs.values()]) if (job.chatId === chatId) this.finish(job, false);
  }

  clear(): void {
    for (const job of [...this.jobs.values()]) this.finish(job, false);
  }

  /** A card nobody answered for a day: its buttons are gone, so it is too. */
  private prune(): void {
    const now = this.now();
    for (const job of [...this.jobs.values()]) if (job.state === "review" && job.expiresAt <= now) this.finish(job, false);
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
