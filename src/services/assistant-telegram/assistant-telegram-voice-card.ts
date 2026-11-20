/**
 * The texts of a voice message on Telegram: the status the bot replies with at once, which is then
 * edited into the review card, the "Sent" or "Cancelled" note, or the reason it could not be read.
 * Every piece of user or tool text is escaped here; callers pass plain text.
 */
import { escapeTelegramHtml } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import { formatVoiceDuration, VOICE_MAX_SECONDS } from "../../shared/voice-message.ts";

export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const WHISPER_MISSING_TEXT = "PPM has no Whisper installed yet, so it can't read voice messages. Open PPM → Settings → Voice to install it.";
export const VOICE_TRANSCRIBING_TEXT = "🎙 Voice message — transcribing…";
export const VOICE_OLD_TEXT = "A voice message sent while PPM was off is not read. Send it again if it still matters.";
export const VOICE_REPLY_HINT = "Reply to this message with the corrected text to replace it.";

const quote = (text: string) => `<blockquote>${escapeTelegramHtml(redactForTelegram(text))}</blockquote>`;

/** What a voice message too long or too large to read is told; null when it can be read. */
export function voiceRefusal(voice: { duration?: number; file_size?: number; file_id?: string }): string | null {
  if (!voice.file_id) return "Telegram did not hand over the voice message.";
  if ((voice.duration ?? 0) > VOICE_MAX_SECONDS) {
    return `That voice message is ${formatVoiceDuration(voice.duration!)} long; PPM reads voice messages up to ${formatVoiceDuration(VOICE_MAX_SECONDS)}. Nothing was sent.`;
  }
  if ((voice.file_size ?? 0) > VOICE_MAX_BYTES) return "That voice message is larger than 10 MB. Nothing was sent.";
  return null;
}

/** The reply sent the moment a voice message arrives; `followsPhotoAt` names a photo already sent. */
export function voiceStatusHtml(followsPhotoAt: string | null): string {
  return followsPhotoAt
    ? `${VOICE_TRANSCRIBING_TEXT}\n<i>It goes on as a follow-up to the photo sent at ${escapeTelegramHtml(followsPhotoAt)}.</i>`
    : VOICE_TRANSCRIBING_TEXT;
}

/** "1 photo · your text": what else goes with the voice in the same message; null when nothing. */
export function withItText(images: number, hasText: boolean): string | null {
  const parts = [...(images ? [`${images} photo${images === 1 ? "" : "s"}`] : []), ...(hasText ? ["your text"] : [])];
  return parts.length ? parts.join(" · ") : null;
}

export interface VoiceCardView {
  transcript: string;
  /** cleaned: Haiku tidied it; raw: it could not (see `reason`); replaced: the user's own words. */
  label: "cleaned" | "raw" | "replaced";
  reason?: string;
  withIt: string | null;
}

export function voiceCardHtml(v: VoiceCardView): string {
  const head = v.label === "raw" ? "⚠️ <b>Transcript · raw</b>" : v.label === "replaced" ? "✏️ <b>Transcript · replaced</b>" : "🎙 <b>Transcript · cleaned</b>";
  const lines = [head];
  if (v.label === "raw") lines.push(`Could not tidy it${v.reason ? `: ${escapeTelegramHtml(v.reason)}` : "."}`);
  lines.push(quote(v.transcript));
  if (v.withIt) lines.push(`With it: ${escapeTelegramHtml(v.withIt)}`);
  lines.push(`<i>${VOICE_REPLY_HINT}</i>`);
  return lines.join("\n");
}

export function voiceSentHtml(transcript: string, learned: readonly string[] = []): string {
  const learnedLine = learned.length ? `\n<i>Learned: ${escapeTelegramHtml(learned.join(", "))}</i>` : "";
  return `✅ <b>Sent</b>\n${quote(transcript)}${learnedLine}`;
}

export function voiceCancelledHtml(restSent: boolean): string {
  return restSent ? "<b>Cancelled</b> — the voice message was dropped; the rest was sent without it." : "<b>Cancelled</b> — nothing was sent.";
}

/** What a failure to read the audio says, by the pipeline's error code. */
export function voiceErrorHtml(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const message = (e as Error | null)?.message || String(e);
  if (code === "whisper_missing") return `⚠️ ${escapeTelegramHtml(WHISPER_MISSING_TEXT)}`;
  if (code === "ffmpeg_missing") return `⚠️ ${escapeTelegramHtml(message)}`;
  return `⚠️ Couldn't read the voice message: ${escapeTelegramHtml(message)}`;
}
