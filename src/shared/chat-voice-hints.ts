/**
 * Hints for reading a voice message that went as Whisper heard it: the words this user's speech
 * was misheard as before (`heard` → `meant`), and the project's own words that sound close to a
 * word in the transcript. The AI reading the message does the guessing a Claude Haiku clean-up
 * used to do, with these in front of it.
 *
 * Only the server writes one (`src/server/ws/chat.ts`, from `voice-hints.ts`), on a voice message
 * the user sent from PPM's chat box or Telegram. Every door breaks its markers in the text it is
 * handed (`neutralizeBlockMarkers`), so a block typed, pasted, dictated or written by another AI
 * never decodes; the decoder rebuilds the whole block from its JSON line and keeps it as text
 * unless the two match byte for byte. It is never part of the user's own words: the bubble, a
 * forwarded card reply and the provenance opening all read the decoded body without it.
 */

export interface VoiceHintPair { heard: string; meant: string }

export interface VoiceHints {
  version: 1;
  /** Corrections learned for this user, whose `heard` side is in the transcript. */
  misheard: VoiceHintPair[];
  /** Project words that sound like a word of the transcript without being spelled in it. */
  close: string[];
}

export const VOICE_HINTS_LIMITS = { misheard: 12, close: 20, chars: 60 } as const;

export const VOICE_HINTS_BLOCK_START = "\n\n<ppm-voice-hints-v1>\n"
  + "PPM attached this to the voice message above; the user did not write it. The transcript is the speech "
  + "recogniser's own text, not corrected. \"misheard\" lists words this user's speech was recognised as before "
  + "(heard) when they meant another (meant); \"close\" lists the project's own words that sound like a word in "
  + "the transcript. Read the transcript with these in mind. Where a word matters for an action (a task code, a "
  + "file, a person, a command) and you are still unsure what was said, ask before acting.\n";
export const VOICE_HINTS_BLOCK_END = "\n</ppm-voice-hints-v1>";
const DATA_PREFIX = "Hints (JSON): ";

const LINE_BREAKS = new RegExp(`[\\u0000-\\u001f\\u007f${String.fromCharCode(0x2028, 0x2029)}]`);
const JSON_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/** A word a hints block may carry: trimmed, non-empty, one line, at most 60 characters. */
export const isHintWord = (v: unknown): v is string =>
  typeof v === "string" && v.trim() === v && v !== "" && Array.from(v).length <= VOICE_HINTS_LIMITS.chars && !LINE_BREAKS.test(v);

/** A hints value checked field by field, or null. Empty hints (nothing to say) are null too. */
export function validateVoiceHints(value: unknown): VoiceHints | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["version", "misheard", "close"].includes(k))) return null;
  if (v.version !== 1 || !Array.isArray(v.misheard) || !Array.isArray(v.close)) return null;
  if (v.misheard.length > VOICE_HINTS_LIMITS.misheard || v.close.length > VOICE_HINTS_LIMITS.close) return null;
  const misheard: VoiceHintPair[] = [];
  for (const item of v.misheard) {
    const pair = item as Record<string, unknown> | null;
    if (!pair || typeof pair !== "object" || Object.keys(pair).some((k) => k !== "heard" && k !== "meant")) return null;
    if (!isHintWord(pair.heard) || !isHintWord(pair.meant)) return null;
    misheard.push({ heard: pair.heard, meant: pair.meant });
  }
  if (!v.close.every(isHintWord)) return null;
  if (!misheard.length && !v.close.length) return null;
  return { version: 1, misheard, close: [...(v.close as string[])] };
}

function block(hints: VoiceHints): string {
  const json = JSON.stringify(hints).replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${VOICE_HINTS_BLOCK_START}${DATA_PREFIX}${json}${VOICE_HINTS_BLOCK_END}`;
}

/** `content` followed by the hints block; unchanged when there are none. Throws on invalid hints. */
export function encodeVoiceHints(content: string, hints?: VoiceHints | null): string {
  if (!hints) return content;
  const valid = validateVoiceHints(hints);
  if (!valid) throw new Error("Invalid voice hints");
  return `${content}${block(valid)}`;
}

/** Splits a trailing hints block off `content`; one that does not rebuild exactly stays text. */
export function decodeVoiceHints(content: string): { content: string; voiceHints: VoiceHints | null } {
  if (!content.endsWith(VOICE_HINTS_BLOCK_END)) return { content, voiceHints: null };
  const at = content.lastIndexOf(VOICE_HINTS_BLOCK_START);
  if (at < 0) return { content, voiceHints: null };
  const inner = content.slice(at + VOICE_HINTS_BLOCK_START.length, content.length - VOICE_HINTS_BLOCK_END.length);
  if (!inner.startsWith(DATA_PREFIX)) return { content, voiceHints: null };
  let hints: VoiceHints | null;
  try {
    hints = validateVoiceHints(JSON.parse(inner.slice(DATA_PREFIX.length)));
  } catch {
    return { content, voiceHints: null };
  }
  if (!hints || block(hints) !== content.slice(at)) return { content, voiceHints: null };
  return { content: content.slice(0, at), voiceHints: hints };
}
