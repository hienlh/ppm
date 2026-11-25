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

/**
 * Where a learned word came from: the user editing a transcript, the clean-up fixing the same
 * misheard word in several messages, or the chat's own AI reading it the same way in several
 * messages ("Hiểu là: heard → meant", see `voice-understood.ts`). The last two are self-learning.
 */
export type LearnedSource = "edit" | "cleanup" | "chat";

/**
 * A correction learned for a project: `from` was heard, `word` was meant. A `term` (a name, an
 * acronym, an identifier) also goes into Whisper's prompt; a `phrase` (ordinary Vietnamese, say
 * "ra lệnh") only reaches the clean-up, so Whisper's Vietnamese is never pulled toward a list.
 * Entries written before self-learning carry only word, from and at: an edit, a term, one hit.
 */
export interface LearnedWord {
  word: string;
  from: string;
  at: string;
  source?: LearnedSource;
  /** Messages the correction was seen in. */
  hits?: number;
  kind?: "term" | "phrase";
  /** The last voice message that used the word (said it, or needed it fixed again); absent: not since `at`. */
  lastUsedAt?: string;
}

/** A correction the clean-up made, counted until it is seen often enough to be learned. */
export interface VoiceCandidate {
  from: string; to: string; hits: number; at: string;
  /**
   * Counted from the chat's reading rather than the clean-up's fixes; absent: the clean-up. The two
   * are counted apart, so one source's guess never makes up the other's count.
   */
  source?: "chat";
  /**
   * For the chat's readings: the readings already counted, `<chat id>@YYYY-MM-DD` (the user's day),
   * since one chat repeats its own guess within a day. An entry with no day is from before readings
   * had one and counts on the day of `at`.
   */
  chats?: string[];
}

/**
 * A learned word the user undid: never learned again from the clean-up, until restored. `at` is
 * when it was undone; the rest is the learned entry as it was, so Restore brings it back unchanged.
 */
export interface BlockedWord {
  word: string; from: string; at: string; source?: LearnedSource; hits?: number; kind?: "term" | "phrase";
  /**
   * Set when the word was still being learned and the user chose "Don't learn": its candidates as
   * they were, so Restore puts them back to be counted rather than making the word learned.
   */
  learning?: VoiceCandidate[];
}

/** Why a heard → meant pair was not counted toward a learned word. */
export type LearnSkipReason =
  | "same-chat" | "not-in-transcript" | "already-spelled" | "case-only" | "plural-only"
  | "undone" | "typed-word" | "too-long" | "secret";

/** What became of one heard → meant pair a learning source read. */
export interface LearnReading {
  from: string;
  to: string;
  status: "learning" | "learned" | "skipped";
  /** Readings counted so far (learning), or the learned word's uses (learned). */
  hits?: number;
  reason?: LearnSkipReason;
}

/** A pair still being counted, as Settings → Voice lists it under "Learning". */
export interface LearningPair { from: string; to: string; hits: number; at: string; source: "cleanup" | "chat"; chats: number }

export interface VoiceProjectWords {
  words: string[];
  learned: LearnedWord[];
  candidates?: VoiceCandidate[];
  blocked?: BlockedWord[];
}

/** One word the clean-up changed: shown on the Telegram card as "Fixed: from → to". */
export interface VoiceFix { from: string; to: string }

/** Where a voice message was recorded: PPM's chat box, or a voice note sent to the Assistant's bot. */
export type VoiceSurface = "composer" | "telegram";
export const VOICE_SURFACES: readonly VoiceSurface[] = ["composer", "telegram"];

/**
 * What happens to Whisper's text before it is sent. `haiku`: Claude Haiku tidies it first (one call,
 * about 3 s a message). `hints`: it goes as Whisper heard it, and PPM's server attaches the words
 * this user's speech was misheard as before, so the AI that reads the message does the guessing.
 */
export type VoiceTranscriptFix = "haiku" | "hints";

/** Each surface's choice when nothing is stored for it — the one place the default is decided. */
export const DEFAULT_TRANSCRIPT_FIX: Readonly<Record<VoiceSurface, VoiceTranscriptFix>> = { composer: "hints", telegram: "hints" };

/** Config key `voice_message`. */
export interface VoiceMessageConfig {
  /** The feature intro's answer (or the Settings switch); undefined = not chosen = off. */
  enabled?: boolean;
  /** Wait for the user to read the transcript before sending. A failed clean-up always waits. */
  review_before_send: boolean;
  /**
   * Per surface: tidy with Haiku, or send Whisper's text with hints. Replaces the single
   * `cleanup_enabled` switch, which a row written before this is read without (see the settings).
   */
  transcript_fix: Record<VoiceSurface, VoiceTranscriptFix>;
  /**
   * Self-learning, as the feature intro or Settings answered; undefined = not chosen = off. With it
   * on, the switches below choose its parts (all default on).
   */
  self_learning?: boolean;
  /** Pick up words from the project's tasks, chats and CLAUDE.md (the Assistant: every project). */
  learn_auto_vocabulary: boolean;
  /** Learn a word once the clean-up fixed it the same way in several messages. */
  learn_from_cleanup: boolean;
  /** Learn a word once the chat's AI read it the same way in several voice messages sent as heard. */
  learn_from_chat: boolean;
  /** List the week's learned words in Monday's morning digest. */
  weekly_summary: boolean;
  /** The clean-up also fixes misheard Vietnamese words by context. Independent of self-learning. */
  vietnamese_fixes: boolean;
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
  return whisperPromptWords(words, maxChars).join(", ");
}

/**
 * Whisper's own limit is in tokens, not characters: `--prompt` keeps at most `n_text_ctx / 2` of
 * them (224 for every model PPM installs), and whisper.cpp builds the prompt by taking the LAST
 * tokens of what it holds — so a list over the limit loses its first words, which are the ones the
 * user typed. 200 leaves room for the token whisper.cpp puts in front.
 */
export const WHISPER_PROMPT_MAX_TOKENS = 200;

/**
 * A deliberately high guess of a word's tokens in Whisper's byte-level vocabulary (no tokenizer
 * ships with PPM): about three ASCII characters a token, two tokens for every other character (a
 * Vietnamese letter with its marks is two or three UTF-8 bytes), and one for the ", " before it.
 */
export function estimateWhisperTokens(word: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of word) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3) + other * 2 + 1;
}

/** The words {@link whisperVocabularyPrompt} keeps, in order (for showing which ones made it). */
export function whisperPromptWords(
  words: readonly string[], maxChars = WHISPER_PROMPT_MAX_CHARS, maxTokens = WHISPER_PROMPT_MAX_TOKENS,
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;
  let tokens = 0;
  for (const raw of words) {
    const word = raw.replace(/\s+/g, " ").trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    const added = (kept.length ? 2 : 0) + word.length;
    const addedTokens = estimateWhisperTokens(word);
    if (length + added > maxChars || tokens + addedTokens > maxTokens) break;
    seen.add(key);
    kept.push(word);
    length += added;
    tokens += addedTokens;
  }
  return kept;
}
