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

/** Marker line + "\n" + transcript. */
export function encodeVoicePart(p: VoicePart): string {
  return `${voiceMarkerLine(p.path, p.durationSec)}\n${p.transcript.trim()}`;
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
    return {
      before: lines.slice(0, i).join("\n").trim(),
      voice: { path: m[3]!, durationSec, transcript: lines.slice(i + 1).join("\n").trim() },
    };
  }
  return { before: text, voice: null };
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
