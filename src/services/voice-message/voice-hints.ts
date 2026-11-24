/**
 * The hints a voice message carries when it goes as Whisper heard it (`chat-voice-hints.ts`): the
 * corrections learned for this user whose misheard side is in the transcript, and the project's
 * own words that sound like a word in it without being spelled there ("hồ nô" for Hono, "BPM"
 * for PPM). Only matches go, never the whole word list: the reader needs the words this message
 * may have got wrong, and a project's list stays out of every message that does not need it.
 *
 * No model call: everything is string comparison. Words are compared by a sound-ish key — no
 * case, no Vietnamese marks, no spaces or punctuation — so "hồ nô" and "Hono" share a key; one
 * letter apart is close for a word of four letters or more, nothing but the same key below that.
 */
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { VOICE_HINTS_LIMITS, type VoiceHintPair, type VoiceHints } from "../../shared/chat-voice-hints.ts";
import { splitVoiceMessage, type LearnedWord, type VoiceMessageConfig, type VoiceSurface } from "../../shared/voice-message.ts";
import { createLogger } from "../logger.ts";
import type { RankedTerm } from "./voice-auto-vocabulary.ts";
import { isFaded, wordUsedIn } from "./voice-learned-fade.ts";
import { MAX_COMPARED_CHARS } from "./voice-word-change.ts";
import { composeVoiceWords } from "./voice-vocabulary.ts";
import { projectWordsOf, readVoiceSettings, selfLearningOn, transcriptFixFor } from "./voice-settings.ts";

const log = createLogger("voice-hints");

/** Project words compared against the transcript at most; the list is ordered most-wanted first. */
const MAX_COMPARED_WORDS = 400;
/** Words of the transcript one project word may stand for ("hồ nô" is two of them). */
const MAX_WINDOW_WORDS = 3;

/** The comparison key: lower case, no marks (đ as d), letters and digits only. */
export function soundKey(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Edits a key this long may be away from a transcript word and still count as close. */
const allowedEdits = (keyLength: number) => (keyLength <= 3 ? 0 : 1);

/** Whether two keys are at most one insertion, deletion or substitution apart. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  // Same length: one substitution, the rest equal. One shorter: one insertion, the rest equal.
  return s.length === l.length ? s.slice(i + 1) === l.slice(i + 1) : s.slice(i) === l.slice(i + 1);
}

/** The keys of every run of one to three transcript words, by key length. */
function transcriptKeys(transcript: string): Map<number, Set<string>> {
  const words = transcript.slice(0, MAX_COMPARED_CHARS).split(/\s+/).map(soundKey).filter(Boolean);
  const byLength = new Map<number, Set<string>>();
  for (let i = 0; i < words.length; i++) {
    let key = "";
    for (let n = 0; n < MAX_WINDOW_WORDS && i + n < words.length; n++) {
      key += words[i + n];
      if (key.length < 3) continue;
      let set = byLength.get(key.length);
      if (!set) byLength.set(key.length, (set = new Set()));
      set.add(key);
    }
  }
  return byLength;
}

/** 0 when a transcript key is the word's own key, 1 when one edit away, null when neither. */
function closeness(key: string, keys: Map<number, Set<string>>): number | null {
  if (keys.get(key.length)?.has(key)) return 0;
  if (allowedEdits(key.length) === 0) return null;
  for (const length of [key.length - 1, key.length, key.length + 1]) {
    for (const candidate of keys.get(length) ?? []) if (withinOneEdit(key, candidate)) return 1;
  }
  return null;
}

/** Most-seen first, then newest. */
const byUse = (a: LearnedWord, b: LearnedWord) => (b.hits ?? 1) - (a.hits ?? 1) || b.at.localeCompare(a.at);

const fits = (word: string) => !!word && Array.from(word).length <= VOICE_HINTS_LIMITS.chars && !/[\r\n]/.test(word);

export interface VoiceHintsInput {
  config: VoiceMessageConfig;
  project: string;
  transcript: string;
  /** The project's picked-up words (self-learning). */
  auto: readonly RankedTerm[];
  nowMs: number;
}

/** The hints for `transcript`, or null when nothing in it looks misheard. */
export function voiceHintsFor(input: VoiceHintsInput): VoiceHints | null {
  const { config, project, transcript, nowMs } = input;
  const selfLearning = selfLearningOn(config);
  // The same corrections the clean-up was given: the clean-up's own lessons only with self-learning on.
  const usable = (l: LearnedWord) => !isFaded(l, nowMs) && (selfLearning || l.source !== "cleanup");
  const learned = [...projectWordsOf(config, project).learned.filter(usable)].sort(byUse);
  // The Assistant is spoken to about every project, so it reads every project's corrections.
  const others = selfLearning && project === ASSISTANT_PROJECT_NAME
    ? Object.entries(config.projects).filter(([name]) => name !== project).flatMap(([, w]) => w.learned).filter(usable).sort(byUse)
    : [];

  const misheard: VoiceHintPair[] = [];
  const named = new Set<string>();
  for (const l of [...learned, ...others]) {
    if (misheard.length >= VOICE_HINTS_LIMITS.misheard) break;
    const meant = l.word.trim();
    const heard = l.from.trim();
    if (!fits(meant) || !fits(heard) || named.has(meant.toLowerCase())) continue;
    if (!wordUsedIn(transcript, heard) || wordUsedIn(transcript, meant)) continue;
    named.add(meant.toLowerCase());
    misheard.push({ heard, meant });
  }

  const keys = transcriptKeys(transcript);
  const words = composeVoiceWords(config, project, { selfLearning, auto: input.auto, nowMs }).cleanup.slice(0, MAX_COMPARED_WORDS);
  const found: Array<{ word: string; edits: number; order: number }> = [];
  words.forEach((raw, order) => {
    const word = raw.trim();
    const key = soundKey(word);
    if (key.length < 3 || !fits(word) || named.has(word.toLowerCase())) return;
    const edits = closeness(key, keys);
    // Spelled right already: nothing to hint. Asked last, since it builds a regex per word.
    if (edits === null || wordUsedIn(transcript, word)) return;
    named.add(word.toLowerCase());
    found.push({ word, edits, order });
  });
  // The same word said differently first ("hồ nô" → Hono), then one letter off, each in list order.
  const close = found.sort((a, b) => a.edits - b.edits || a.order - b.order).slice(0, VOICE_HINTS_LIMITS.close).map((f) => f.word);

  return misheard.length || close.length ? { version: 1, misheard, close } : null;
}

export interface MessageVoiceHintsDeps {
  read?: () => VoiceMessageConfig;
  autoVocabulary?: (project: string) => Promise<RankedTerm[]>;
  now?: () => number;
}

/**
 * The hints to attach to a message the user sent from `surface`, or null: when the message has no
 * voice part, voice messages are off, or that surface tidies with Haiku instead. Never throws —
 * a message is sent without hints rather than not sent.
 */
export async function voiceHintsForMessage(
  text: string, project: string, surface: VoiceSurface, deps: MessageVoiceHintsDeps = {},
): Promise<VoiceHints | null> {
  try {
    const transcript = splitVoiceMessage(text).voice?.transcript.trim();
    if (!transcript) return null;
    const config = (deps.read ?? readVoiceSettings)();
    if (config.enabled !== true || transcriptFixFor(config, surface) !== "hints") return null;
    const wantsAuto = selfLearningOn(config) && config.learn_auto_vocabulary;
    const load = deps.autoVocabulary ?? (async (p: string) => (await import("./voice-auto-vocabulary-sources.ts")).autoVocabulary(p));
    const auto = wantsAuto ? await load(project).catch((): RankedTerm[] => []) : [];
    return voiceHintsFor({ config, project, transcript, auto, nowMs: (deps.now ?? Date.now)() });
  } catch (e) {
    log.warn(`voice hints left out: ${(e as Error).message}`);
    return null;
  }
}
