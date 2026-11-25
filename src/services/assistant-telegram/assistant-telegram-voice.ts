/**
 * Voice messages sent to the PPM Assistant's bot: read with the same pipeline as PPM's composer
 * (Whisper, then a Claude clean-up), then sent as one message with whatever was gathered with them.
 *
 * Reading takes seconds, so it runs off the chat's lane: texts and photos keep arriving meanwhile
 * and join the voice's bundle, which stays open until the transcript is ready. Only the end of it
 * comes back onto the lane (`host.onLane`), so it never races a typed message or a button.
 *
 * The status message the bot replies with at once is the one later edited into the review card
 * (Send / Cancel; a reply to it with text replaces the transcript) or into "Sent".
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ensureUploadsDir } from "../chat-upload-storage.service.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { VoicePart } from "../../shared/voice-message.ts";
import type { TelegramBotClient } from "../telegram/telegram-bot-client.ts";
import type { InlineKeyboardMarkup, TelegramMessage } from "../telegram/telegram-types.ts";
import { outcomeOf, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import type { BridgeAction } from "./assistant-telegram-actions.ts";
import { boundSession } from "./assistant-telegram-binding.ts";
import type { TelegramVoiceDeps, VoiceProcessResult } from "./assistant-telegram-voice-deps.ts";
import { PendingVoices, voiceExpiry, type VoiceBundle, type VoiceJob } from "./assistant-telegram-voice-pending.ts";
import {
  VOICE_MAX_BYTES, VOICE_REPLACE_MAX_CHARS, VOICE_REPLACE_TOO_LONG_TEXT, voiceCancelledHtml, voiceCardHtml,
  voiceErrorHtml, voiceExpiredHtml, voiceSentHtml, voiceStatusHtml, withItText,
} from "./assistant-telegram-voice-card.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/** What the inbound router lends the voice messages: its lanes, its delivery, its gather. */
export interface VoiceHost {
  client: TelegramBotClient;
  queue: AssistantTelegramSendQueue;
  codes: ButtonCodes<BridgeAction>;
  deps: TelegramVoiceDeps;
  now: () => number;
  reply(chatId: string, html: string): void;
  onLane(chatId: string, work: () => Promise<void>): void;
  /** Nothing more joins the bundle: it leaves the chat's gather. */
  release(chatId: string, bundle: VoiceBundle): void;
  /** Sends the bundle as one message, the voice part last (or, for `bundle.words`, as an answer), and confirms its updates. */
  deliverBundle(chatId: string, bundle: VoiceBundle, voice: VoicePart | null): Promise<void>;
  /** The bundle's updates are handed on (it now waits in memory for the user's answer). */
  confirm(bundle: VoiceBundle): void;
  /** "16:10" when a photo went to the Assistant a moment ago, so the voice is its follow-up. */
  recentPhotoAt(chatId: string): string | null;
}

export class TelegramVoiceMessages {
  private readonly pending: PendingVoices;

  constructor(private readonly host: VoiceHost) {
    // An expired card still owes the chat what came with its voice; the end runs on the chat's lane.
    this.pending = new PendingVoices(host.now, (job) => host.onLane(job.chatId, () => this.expired(job)));
  }

  /**
   * Starts reading `message`'s voice note — or audio file, whose extension `audioExt` names — for
   * `bundle` (already marked as owned by a voice) and returns.
   */
  start(chatId: string, message: TelegramMessage, bundle: VoiceBundle, audioExt?: string): void {
    const media = message.voice ?? message.audio;
    const job: VoiceJob = {
      id: randomUUID().slice(0, 12), chatId, bundle, durationSec: media?.duration ?? 0, state: "processing",
      proposed: "", transcript: "", label: "cleaned", expiresAt: voiceExpiry(this.host.now()),
      ...(audioExt ? { audioExt } : {}),
    };
    bundle.voice = job.id;
    this.pending.add(job);
    this.show(job, voiceStatusHtml(bundle.words ? null : this.host.recentPhotoAt(chatId), !!audioExt, !!bundle.words));
    void this.read(job, media?.file_id ?? "").then(
      (result) => this.host.onLane(chatId, () => this.ready(job, result)),
      (e) => this.host.onLane(chatId, () => this.failed(job, e)),
    );
  }

  /** A reply with text to a review card replaces its transcript; false when `message` is not one. */
  replace(chatId: string, message: TelegramMessage): boolean {
    const repliedTo = message.reply_to_message?.message_id;
    const job = repliedTo === undefined ? undefined : this.pending.cardAt(chatId, repliedTo);
    if (!job) return false;
    const text = (message.text ?? message.caption ?? "").trim();
    if (!text) {
      this.host.reply(chatId, "Reply with the corrected text to replace the transcript.");
      return true;
    }
    if (text.length > VOICE_REPLACE_MAX_CHARS) {
      this.host.reply(chatId, VOICE_REPLACE_TOO_LONG_TEXT);
      return true;
    }
    job.transcript = text;
    job.label = "replaced";
    this.showCard(job);
    return true;
  }

  /** Send or Cancel on a review card: the toast to show. Runs on the chat's lane. */
  async press(chatId: string, action: Extract<BridgeAction, { kind: "voice" }>, group: string): Promise<string> {
    const job = this.pending.get(action.id);
    this.host.codes.dropGroup(group);
    if (!job || job.chatId !== chatId || job.state !== "review") return "This button is no longer valid.";
    if (action.send) {
      await this.send(job);
      return "Sending it now.";
    }
    this.pending.finish(job, false);
    const rest = hasRest(job.bundle);
    this.show(job, voiceCancelledHtml(rest));
    job.bundle.voice = undefined;
    if (rest) await this.host.deliverBundle(chatId, job.bundle, null);
    return "Cancelled.";
  }

  forgetChat(chatId: string): void {
    this.pending.forgetChat(chatId);
  }

  /** Whether a voice message is still being downloaded or read (not one waiting on the user). */
  reading(): boolean {
    return this.pending.reading();
  }

  stop(): void {
    this.pending.clear();
  }

  /** Downloads, stores and reads the audio. Runs off the lane: it takes seconds. */
  private async read(job: VoiceJob, fileId: string): Promise<VoiceProcessResult> {
    const file = await this.host.client.getFile(fileId);
    if (!file.ok || !file.result.file_path) throw new Error("Telegram did not hand over the voice message.");
    const bytes = await this.host.client.downloadFile(file.result.file_path, VOICE_MAX_BYTES);
    if (!bytes.ok) throw new Error(bytes.description === "file too large" ? "it is larger than 10 MB." : "it could not be downloaded from Telegram.");
    // Kept with the chat, like a pasted image: the message names this file and PPM plays it back.
    const name = job.audioExt ? `telegram-audio.${job.audioExt}` : "telegram-voice.ogg";
    job.path = join(ensureUploadsDir(), `${randomUUID().slice(0, 8)}-${name}`);
    await Bun.write(job.path, bytes.result);
    // Forgotten while it downloaded (chat disconnected, bridge stopped): finish() had no file to delete.
    if (job.state === "done") {
      rmSync(job.path, { force: true });
      throw new Error("the voice message was dropped while it downloaded.");
    }
    const bound = boundSession(job.chatId);
    return this.host.deps.process({
      audio: bytes.result, project: ASSISTANT_PROJECT_NAME,
      ...(bound ? { sessionId: bound.sessionId, providerId: bound.providerId } : {}),
    });
  }

  private async ready(job: VoiceJob, result: VoiceProcessResult): Promise<void> {
    if (job.state !== "processing") return; // forgotten meanwhile (chat disconnected, bridge stopped)
    if (!result.text.trim()) return this.failed(job, new Error("no speech was heard in it."));
    this.host.release(job.chatId, job.bundle);
    job.proposed = result.text.trim();
    job.transcript = job.proposed;
    job.label = result.cleaned ? "cleaned" : result.cleanupSkipped ? "plain" : "raw";
    if (result.cleanupError) job.reason = result.cleanupError;
    if (result.fixes?.length) job.fixes = result.fixes;
    job.timing = { whisperMs: result.transcribeMs, ...(result.cleaned || result.cleanupError ? { haikuMs: result.cleanupMs } : {}) };
    if (result.learned?.length) job.learned = result.learned.map((l) => ({ word: l.word, from: l.from }));
    // A transcript Haiku could not tidy is always read first: it may be wrong in ways nobody fixed.
    // One the user chose not to have tidied follows the review setting like a tidied one.
    if ((result.cleaned || result.cleanupSkipped) && !this.host.deps.reviewBeforeSend()) return this.send(job, true);
    job.state = "review";
    const group = `voice:${job.id}`;
    job.markup = { inline_keyboard: [[
      { text: "Send", callback_data: this.host.codes.mint(job.chatId, group, { kind: "voice", id: job.id, send: true }) },
      { text: "Cancel", callback_data: this.host.codes.mint(job.chatId, group, { kind: "voice", id: job.id, send: false }) },
    ]] };
    this.showCard(job);
    // Waiting on a person can take hours; the updates must not be read again after a restart.
    this.host.confirm(job.bundle);
    // Nothing else would look at the card again if nobody touches the chat: its own timer does.
    const timer = setTimeout(() => this.pending.sweep(), Math.max(0, job.expiresAt - this.host.now()) + 1_000);
    (timer as { unref?: () => void }).unref?.();
    job.expiryTimer = timer;
  }

  /** A card's day ran out: the buttons go, the card says so, and what came with the voice is sent. */
  private async expired(job: VoiceJob): Promise<void> {
    this.host.codes.dropGroup(`voice:${job.id}`);
    const rest = hasRest(job.bundle);
    this.show(job, voiceExpiredHtml(rest));
    job.bundle.voice = undefined;
    if (rest) await this.host.deliverBundle(job.chatId, job.bundle, null);
  }

  private async failed(job: VoiceJob, e: unknown): Promise<void> {
    if (job.state !== "processing") return;
    log.info(`Telegram chat ${job.chatId}: voice message not read: ${(e as Error)?.message ?? e}`);
    this.host.release(job.chatId, job.bundle);
    this.pending.finish(job, false);
    this.show(job, voiceErrorHtml(e));
    // What came with the voice still goes; only the voice is lost.
    job.bundle.voice = undefined;
    if (hasRest(job.bundle)) await this.host.deliverBundle(job.chatId, job.bundle, null);
    else this.host.confirm(job.bundle);
  }

  /** `noCard`: sent without a review card, so the "Sent" note carries the fixes and times itself. */
  private async send(job: VoiceJob, noCard = false): Promise<void> {
    this.pending.finish(job, true);
    const transcript = job.transcript;
    const extras = {
      ...(noCard && job.fixes ? { fixes: job.fixes } : {}),
      ...(noCard && job.timing ? { timing: job.timing } : {}),
      ...(job.learned ? { learned: job.learned } : {}),
    };
    // An answer to a card is not "Sent" yet: where it goes, or why it does not, is said next.
    const answers = !!job.bundle.words;
    this.show(job, voiceSentHtml(transcript, answers ? { ...extras, answers } : extras));
    job.bundle.voice = undefined;
    await this.host.deliverBundle(job.chatId, job.bundle, { path: job.path!, durationSec: job.durationSec, transcript });
    if (transcript === job.proposed) return;
    // Learned after the message went: the user waits for nothing, and a failure costs only a hint.
    void this.host.deps.learn({ project: ASSISTANT_PROJECT_NAME, before: job.proposed, after: transcript })
      .then((words) => {
        if (words.length) this.show(job, voiceSentHtml(transcript, { ...extras, ...(answers ? { answers } : {}), learned: [...(job.learned ?? []), ...words] }));
      })
      .catch((err) => log.warn(`Telegram chat ${job.chatId}: learning from a corrected transcript failed: ${(err as Error)?.message ?? err}`));
  }

  private showCard(job: VoiceJob): void {
    this.show(job, voiceCardHtml({
      transcript: job.transcript, label: job.label, ...(job.reason ? { reason: job.reason } : {}),
      withIt: withItText(job.bundle.images.length, job.bundle.parts.some((p) => p.trim())),
      ...(job.fixes ? { fixes: job.fixes } : {}), ...(job.timing ? { timing: job.timing } : {}),
    }), job.markup);
  }

  /**
   * Sends the job's status message the first time, edits it after; queued in the chat's send lane,
   * so an edit always runs after the send that made the message. No markup takes the buttons away.
   */
  private show(job: VoiceJob, html: string, markup?: InlineKeyboardMarkup): void {
    let attempts = 0;
    const { chatId } = job;
    this.host.queue.enqueue(chatId, {
      final: true, label: "voice message",
      run: async (client) => {
        attempts++;
        if (job.messageId === undefined) {
          const res = await client.sendMessage(chatId, html, markup ? { replyMarkup: markup } : {});
          if (res.ok) { job.messageId = res.result.message_id; this.host.queue.noteSent(chatId); }
          return outcomeOf(res, attempts);
        }
        return outcomeOf(await client.editMessageText(chatId, job.messageId, html, { final: true, ...(markup ? { replyMarkup: markup } : {}) }), attempts);
      },
    });
  }
}

function hasRest(bundle: VoiceBundle): boolean {
  return bundle.images.length > 0 || bundle.parts.some((p) => p.trim());
}
