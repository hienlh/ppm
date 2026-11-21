/**
 * Words the clean-up taught fade when they stop being said: one not used for {@link VOICE_FADE_DAYS}
 * days leaves the list by itself, so a wrong correction learned once does not stay until somebody
 * undoes it. A word counts as used when it appears in a voice message's transcript (as Whisper
 * heard it, or as the clean-up wrote it) or when the clean-up fixes it again.
 *
 * Only `source: "cleanup"` fades. Words the user typed into a list never do, and neither do words
 * learned from the user's own edits: those are corrections somebody made on purpose. Pure, with
 * the time passed in, so the rules are tested without waiting thirty days.
 */
import type { LearnedWord, VoiceCandidate } from "../../shared/voice-message.ts";

export const VOICE_FADE_DAYS = 30;
const FADE_MS = VOICE_FADE_DAYS * 24 * 60 * 60 * 1000;

/** When a learned word was last used: its last use, or when it was learned if never used since. */
export function learnedLastUsed(l: LearnedWord): string {
  return l.lastUsedAt ?? l.at;
}

/** Whether a learned word has faded: taught by the clean-up and unused for longer than the window. */
export function isFaded(l: LearnedWord, nowMs: number): boolean {
  if (l.source !== "cleanup") return false;
  const last = Date.parse(learnedLastUsed(l));
  return Number.isFinite(last) && nowMs - last > FADE_MS;
}

/** A candidate not seen for the same window is dropped too: counting it on would be counting old news. */
export function isStaleCandidate(c: VoiceCandidate, nowMs: number): boolean {
  const last = Date.parse(c.at);
  return Number.isFinite(last) && nowMs - last > FADE_MS;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `word` appears in `text` as a whole word or phrase, ignoring case. */
export function wordUsedIn(text: string, word: string): boolean {
  if (!word.trim()) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(word)}($|[^\\p{L}\\p{N}])`, "iu").test(text.normalize("NFC"));
}
