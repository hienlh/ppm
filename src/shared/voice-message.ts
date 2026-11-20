/**
 * Voice messages: a recording PPM transcribes on the host (Whisper) and tidies with Claude Haiku,
 * sent as part of an ordinary chat message.
 *
 * In the message text a voice part is one marker line followed by the transcript, always last:
 *
 *   [Voice message (0:42), transcribed below; the audio needs no opening: /abs/path/to/audio.wav]
 *   the transcript, on as many lines as it takes
 *
 * The marker tells the model that the words below are what was said, so it never tries to open
 * the audio; the bubble reads the same marker back to draw a player. Shared by server and browser,
 * so nothing here may import from `src/services` or `src/web`.
 */

/** Longest recording the composer and the Telegram bridge accept. */
export const VOICE_MAX_SECONDS = 120;

/** A correction learned from the user editing a transcript: `from` was heard, `word` was meant. */
export interface LearnedWord { word: string; from: string; at: string }

export interface VoiceProjectWords { words: string[]; learned: LearnedWord[] }

/** Config key `voice_message`. */
export interface VoiceMessageConfig {
  /** The feature intro's answer (or the Settings switch); undefined = not chosen = off. */
  enabled?: boolean;
  /** Wait for the user to read the transcript before sending. A failed clean-up always waits. */
  review_before_send: boolean;
  /**
   * Tidy the transcript with Claude Haiku (and learn from edits to it). Off: Whisper's text is used
   * as it is and Haiku is never called. A row written before the switch existed has none: on.
   */
  cleanup_enabled: boolean;
  /** Words for every project. */
  words: string[];
  /** Keyed by project name; `__assistant__` for the PPM Assistant. */
  projects: Record<string, VoiceProjectWords>;
}

export interface VoicePart { path: string; durationSec: number; transcript: string }

/** 42 -> "0:42", 125 -> "2:05". Negative, fractional or non-finite input is rounded into range. */
export function formatVoiceDuration(sec: number): string {
  const total = Number.isFinite(sec) ? Math.max(0, Math.round(sec)) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const MARKER_PREFIX = "[Voice message (";
const MARKER_RE = /^\[Voice message \((\d+):(\d{2})\), transcribed below; the audio needs no opening: (.+)\]$/;

/** The marker line alone. A path never carries a line break into it, or the marker would split. */
export function voiceMarkerLine(path: string, durationSec: number): string {
  const safePath = path.replace(/[\r\n]+/g, " ").trim();
  return `${MARKER_PREFIX}${formatVoiceDuration(durationSec)}), transcribed below; the audio needs no opening: ${safePath}]`;
}

/**
 * Written under the marker for the model that reads the message, never shown to the user (the
 * split drops it). Even after the clean-up a transcript can carry a misheard term, and an agent
 * that takes it literally acts on a word the user never said.
 */
export const VOICE_NOTE = "(Transcribed automatically from speech, so words may be misheard, especially technical terms and names. Read it in context; where something does not make sense, ask instead of guessing.)";

/**
 * Marker line + the note for the model + transcript. A transcript line shaped like a marker
 * (dictated, typed into the block, or written by the clean-up) gets a zero-width space before its
 * bracket: the split looks for the LAST marker line, so a forged one below the real marker would
 * move the voice part onto a path the transcript chose.
 */
export function encodeVoicePart(p: VoicePart): string {
  const transcript = p.transcript.trim()
    .replace(/^([^\S\r\n]*)\[Voice message \(/gm, `$1${String.fromCharCode(0x200b)}[Voice message (`);
  return `${voiceMarkerLine(p.path, p.durationSec)}\n${VOICE_NOTE}\n${transcript}`;
}

/**
 * The voice part of a message, found at the LAST line that is a whole marker: `before` is the text
 * above it and `voice.transcript` the text below, both trimmed. A marker inside a line (quoted by
 * the user, say) is not one. Text with no marker comes back whole as `before`.
 */
export function splitVoiceMessage(text: string): { before: string; voice: VoicePart | null } {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/\r$/, "");
    if (!line.startsWith(MARKER_PREFIX)) continue;
    const m = MARKER_RE.exec(line);
    if (!m) continue;
    const durationSec = Number(m[1]) * 60 + Number(m[2]);
    // The note for the model sits right under the marker; messages sent before it existed have none.
    const below = lines.slice(i + 1);
    if (below[0]?.replace(/\r$/, "") === VOICE_NOTE) below.shift();
    return {
      before: lines.slice(0, i).join("\n").trim(),
      voice: { path: m[3]!, durationSec, transcript: below.join("\n").trim() },
    };
  }
  return { before: text, voice: null };
}

/**
 * Whether a marker's path is a recording PPM itself stored: a file directly inside an `uploads`
 * folder, named the way the upload routes and the Telegram bridge name one (letters, digits,
 * `.`, `_`, `-`), with an audio extension. The bubble only draws a player for such a path, so a
 * marker typed or quoted into a message cannot point the player at any other file on the host.
 */
export function isStoredVoicePath(path: string): boolean {
  const m = /[/\\]uploads[/\\]([^/\\]+)$/.exec(path);
  return !!m && /^[A-Za-z0-9._-]+\.(webm|ogg|oga|opus|m4a|mp4|wav|mp3)$/i.test(m[1]!) && !m[1]!.startsWith(".");
}

/**
 * The message as words only — typed text then the transcript — for places that show a message as
 * one line of text (a new chat's title, ArrowUp recall, a reply quote). The marker names a file
 * path, which means nothing there and would push the words out of a 50-character title.
 */
export function voicePlainText(text: string): string {
  const { before, voice } = splitVoiceMessage(text);
  if (!voice) return text;
  return [before, voice.transcript].filter(Boolean).join("\n\n");
}

/** Default length of Whisper's `--prompt`: the model reads a short hint better than a long list. */
export const WHISPER_PROMPT_MAX_CHARS = 600;

/**
 * The vocabulary hint handed to Whisper: the words in order, each once (compared without case),
 * joined with ", " and cut at a whole word so the hint never ends on half a term.
 */
export function whisperVocabularyPrompt(words: readonly string[], maxChars = WHISPER_PROMPT_MAX_CHARS): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;
  for (const raw of words) {
    const word = raw.replace(/\s+/g, " ").trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    const added = (kept.length ? 2 : 0) + word.length;
    if (length + added > maxChars) break;
    seen.add(key);
    kept.push(word);
    length += added;
  }
  return kept.join(", ");
}
