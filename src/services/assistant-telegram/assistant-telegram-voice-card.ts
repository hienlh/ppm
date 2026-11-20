/**
 * The texts of a voice message on Telegram: the status the bot replies with at once, which is then
 * edited into the review card, the "Sent" or "Cancelled" note, or the reason it could not be read.
 * Every piece of user or tool text is escaped here; callers pass plain text.
 */
import { escapeTelegramHtml } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import { formatVoiceDuration, VOICE_MAX_SECONDS, type VoiceFix } from "../../shared/voice-message.ts";

export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const WHISPER_MISSING_TEXT = "PPM has no Whisper installed yet, so it can't read voice messages. Open PPM → Settings → Voice to install it.";
export const VOICE_TRANSCRIBING_TEXT = "🎙 Voice message — transcribing…";
export const AUDIO_TRANSCRIBING_TEXT = "🎵 Audio file — transcribing…";
export const VOICE_FORWARDED_TEXT = "PPM reads your own voice messages only, not forwarded ones. Nothing was sent.";
export const AUDIO_FORMAT_TEXT = "PPM reads voice messages and audio files in mp3, m4a, ogg, opus, wav or webm. Nothing was sent.";
export const VOICE_OLD_TEXT = "A voice message sent while PPM was off is not read. Send it again if it still matters.";
export const VOICE_REPLY_HINT = "Reply to this message with the corrected text to replace it.";
/**
 * Longest replacement a card can show. Telegram refuses a message over 4096 characters, and the
 * card adds its header, the reason and the hint around the transcript: an edit that fails would
 * leave the old transcript on screen while Send delivered the new one.
 */
export const VOICE_REPLACE_MAX_CHARS = 3_500;
export const VOICE_REPLACE_TOO_LONG_TEXT =
  `That is too long to replace the transcript with (at most ${VOICE_REPLACE_MAX_CHARS.toLocaleString("en-US")} characters). The card is unchanged; send a shorter text, or Cancel and send it as a message.`;

const quote = (text: string) => `<blockquote>${escapeTelegramHtml(redactForTelegram(text))}</blockquote>`;

/** What a voice message (or an audio file) too long or too large to read is told; null when it can be read. */
export function voiceRefusal(voice: { duration?: number; file_size?: number; file_id?: string }, what = "voice message"): string | null {
  if (!voice.file_id) return `Telegram did not hand over the ${what}.`;
  if ((voice.duration ?? 0) > VOICE_MAX_SECONDS) {
    return `That ${what} is ${formatVoiceDuration(voice.duration!)} long; PPM reads ${what}s up to ${formatVoiceDuration(VOICE_MAX_SECONDS)}. Nothing was sent.`;
  }
  if ((voice.file_size ?? 0) > VOICE_MAX_BYTES) return `That ${what} is larger than 10 MB. Nothing was sent.`;
  return null;
}

/** The reply sent the moment a voice message arrives; `followsPhotoAt` names a photo already sent. */
export function voiceStatusHtml(followsPhotoAt: string | null, audioFile = false): string {
  const head = audioFile ? AUDIO_TRANSCRIBING_TEXT : VOICE_TRANSCRIBING_TEXT;
  return followsPhotoAt
    ? `${head}\n<i>It goes on as a follow-up to the photo sent at ${escapeTelegramHtml(followsPhotoAt)}.</i>`
    : head;
}

/**
 * The reply to a voice message while the feature is off — said plainly, instead of the generic
 * "text and photos only". The button to turn it on is offered by the caller only when Whisper is
 * installed; without it the reply says where to install.
 */
export function voiceOffHtml(whisperReady: boolean): string {
  const how = whisperReady
    ? "Turn them on here, or in PPM → Settings → Voice."
    : "Install Whisper and turn them on in PPM → Settings → Voice.";
  return `🔇 Voice messages are turned off in PPM, so this one was not read and nothing was sent.\n<i>${how}</i>`;
}

/** Seconds as the card shows them: "4.1 s". */
const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

/** How long each step took, on one line; Haiku only when it ran. */
export function voiceTimingText(t: { whisperMs: number; haikuMs?: number }): string {
  return t.haikuMs !== undefined
    ? `Whisper ${seconds(t.whisperMs)} · Haiku ${seconds(t.haikuMs)}`
    : `Whisper ${seconds(t.whisperMs)}`;
}

/** Escaped and redacted, as the quoted transcript is: a fix or a learned word must not show a secret it hides. */
const safe = (text: string) => escapeTelegramHtml(redactForTelegram(text));

/** "Fixed: <s>BPM</s> → <b>PPM</b> · …": every word the clean-up replaced, so none goes unseen. */
export function voiceFixesHtml(fixes: readonly VoiceFix[]): string | null {
  if (!fixes.length) return null;
  return `Fixed: ${fixes.map((f) => `<s>${safe(f.from)}</s> → <b>${safe(f.to)}</b>`).join(" · ")}`;
}

const AUDIO_EXT_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "m4a",
  "audio/ogg": "ogg", "audio/opus": "opus", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/webm": "webm",
};
const AUDIO_EXTS = new Set(["mp3", "m4a", "mp4", "ogg", "oga", "opus", "wav", "webm"]);

/**
 * The extension an audio file is stored under — one the chat's player accepts — from its MIME type,
 * else from its file name; null for a format PPM does not read.
 */
export function audioFileExt(audio: { mime_type?: string; file_name?: string }): string | null {
  const byMime = audio.mime_type ? AUDIO_EXT_BY_MIME[audio.mime_type.toLowerCase().split(";")[0]!.trim()] : undefined;
  if (byMime) return byMime;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(audio.file_name ?? "")?.[1]?.toLowerCase();
  return ext && AUDIO_EXTS.has(ext) ? ext : null;
}

/** What a learned word reads as: "PPM (heard as BPM)". */
export interface LearnedView { word: string; from?: string }
const learnedText = (l: LearnedView) => (l.from ? `${l.word} (heard as ${l.from})` : l.word);

/** "1 photo · your text": what else goes with the voice in the same message; null when nothing. */
export function withItText(images: number, hasText: boolean): string | null {
  const parts = [...(images ? [`${images} photo${images === 1 ? "" : "s"}`] : []), ...(hasText ? ["your text"] : [])];
  return parts.length ? parts.join(" · ") : null;
}

export interface VoiceCardView {
  transcript: string;
  /** cleaned: Haiku tidied it; raw: it could not (see `reason`); replaced: the user's own words; plain: the clean-up is off. */
  label: "cleaned" | "raw" | "replaced" | "plain";
  reason?: string;
  withIt: string | null;
  fixes?: readonly VoiceFix[];
  timing?: { whisperMs: number; haikuMs?: number };
}

export function voiceCardHtml(v: VoiceCardView): string {
  const head = v.label === "raw" ? "⚠️ <b>Transcript · raw</b>" : v.label === "replaced" ? "✏️ <b>Transcript · replaced</b>" : v.label === "plain" ? "🎙 <b>Transcript</b>" : "🎙 <b>Transcript · cleaned</b>";
  const lines = [head];
  if (v.label === "raw") lines.push(`Could not tidy it${v.reason ? `: ${escapeTelegramHtml(v.reason)}` : "."}`);
  lines.push(quote(v.transcript));
  // A replaced transcript is the user's own words: the clean-up's fixes no longer describe it.
  const fixes = v.label === "cleaned" && v.fixes ? voiceFixesHtml(v.fixes) : null;
  if (fixes) lines.push(fixes);
  if (v.withIt) lines.push(`With it: ${escapeTelegramHtml(v.withIt)}`);
  if (v.timing) lines.push(`<i>${voiceTimingText(v.timing)}</i>`);
  lines.push(`<i>${VOICE_REPLY_HINT}</i>`);
  return lines.join("\n");
}

export interface VoiceSentExtras {
  learned?: readonly LearnedView[];
  /** Given only when no card was shown (review off): otherwise the card already said them. */
  fixes?: readonly VoiceFix[];
  timing?: { whisperMs: number; haikuMs?: number };
}

export function voiceSentHtml(transcript: string, extras: VoiceSentExtras = {}): string {
  const lines = ["✅ <b>Sent</b>", quote(transcript)];
  const fixes = extras.fixes ? voiceFixesHtml(extras.fixes) : null;
  if (fixes) lines.push(fixes);
  if (extras.timing) lines.push(`<i>${voiceTimingText(extras.timing)}</i>`);
  if (extras.learned?.length) {
    lines.push(`<i>Learned: ${safe(extras.learned.map(learnedText).join(", "))}. Undo in PPM → Settings → Voice.</i>`);
  }
  return lines.join("\n");
}

export function voiceExpiredHtml(restSent: boolean): string {
  return restSent
    ? "⌛ <b>Expired</b> — nobody pressed Send within a day, so the voice message was dropped; what came with it was sent without it."
    : "⌛ <b>Expired</b> — nobody pressed Send within a day, so the voice message was dropped.";
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
