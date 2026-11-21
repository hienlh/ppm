/**
 * The word lists one voice message is given: the short one for Whisper's prompt (600 characters,
 * names and identifiers only) and the long one for the clean-up, plus the corrections the
 * clean-up should know were misheard before. Built from the user's own lists, what PPM learned,
 * and — with self-learning on — the words picked up from the project's own text.
 *
 * The user's words come first, so a list they typed is never pushed out of Whisper's 600
 * characters by anything PPM picked up. With self-learning off nothing picked up or learned by
 * the clean-up is added, and no corrections are passed.
 */
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { whisperPromptWords, type LearnedWord, type VoiceMessageConfig } from "../../shared/voice-message.ts";
import type { RankedTerm } from "./voice-auto-vocabulary.ts";
import { isFaded } from "./voice-learned-fade.ts";
import { projectWordsOf } from "./voice-settings.ts";

/** Task codes at most in Whisper's prompt: each is cheap to say and costly in characters. */
const WHISPER_MAX_CODES = 10;
/** Corrections the clean-up is told about, newest first. */
const MAX_CORRECTIONS = 40;
const CODE = /^[A-Za-z][\w.-]*\/\d+$|^[A-Z][A-Z0-9]+-\d+$/;

export interface VoiceWordLists {
  whisper: string[];
  cleanup: string[];
  corrections: Array<{ heard: string; meant: string }>;
  /** Lower-cased words that are the project's own (typed or picked up): learning trusts them sooner. */
  known: Set<string>;
}

/** Most-seen first, then newest. */
const byUse = (a: LearnedWord, b: LearnedWord) => (b.hits ?? 1) - (a.hits ?? 1) || b.at.localeCompare(a.at);

function dedupe(words: readonly string[]): string[] {
  const seen = new Set<string>();
  return words.filter((w) => {
    const key = w.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function composeVoiceWords(
  config: VoiceMessageConfig,
  project: string,
  opts: { selfLearning: boolean; auto: readonly RankedTerm[]; nowMs?: number },
): VoiceWordLists {
  const nowMs = opts.nowMs ?? Date.now();
  // A faded word is left out even before the next message prunes it from the row.
  const own = { ...projectWordsOf(config, project) };
  own.learned = own.learned.filter((l) => !isFaded(l, nowMs));
  // Off, the words the clean-up taught pause; words learned from the user's own edits keep working.
  const learned = [...own.learned].filter((l) => opts.selfLearning || l.source !== "cleanup").sort(byUse);
  const learnedTerms = learned.filter((l) => l.kind !== "phrase").map((l) => l.word);
  // The Assistant is spoken to about every project, so it also knows what each of them learned.
  const others = opts.selfLearning && project === ASSISTANT_PROJECT_NAME
    ? Object.entries(config.projects).filter(([name]) => name !== project)
      .flatMap(([, words]) => words.learned).filter((l) => !isFaded(l, nowMs)).sort(byUse).filter((l) => l.kind !== "phrase").map((l) => l.word)
    : [];
  const auto = opts.selfLearning ? opts.auto : [];
  let codes = 0;
  const autoForWhisper = auto.filter((t) => t.strong && (!CODE.test(t.term) || ++codes <= WHISPER_MAX_CODES)).map((t) => t.term);

  return {
    whisper: dedupe([...own.words, ...learnedTerms, ...config.words, ...others, ...autoForWhisper]),
    cleanup: dedupe([...own.words, ...(opts.selfLearning ? learnedTerms : learned.map((l) => l.word)), ...config.words, ...others, ...auto.map((t) => t.term)]),
    corrections: opts.selfLearning
      ? [...own.learned].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_CORRECTIONS).map((l) => ({ heard: l.from, meant: l.word }))
      : [],
    known: new Set([...own.words, ...config.words, ...auto.map((t) => t.term)].map((w) => w.toLowerCase())),
  };
}

/**
 * Whether Whisper wrote its own prompt back instead of speech: a comma list made mostly of the
 * prompt's words. Whisper does this on audio with almost nothing in it; VAD stops most of it, and
 * this stops the rest from reaching the clean-up and the chat as if it were said.
 */
export function looksLikePromptEcho(transcript: string, promptWords: readonly string[]): boolean {
  const pieces = transcript.split(",").map((p) => p.replace(/[.\s]+$/g, "").trim().toLowerCase()).filter(Boolean);
  if (pieces.length < 5) return false;
  // Whisper reads its prompt back in order; a person listing a few of the same names says other words too.
  const order = new Map(promptWords.map((w, i) => [w.toLowerCase(), i]));
  let last = -1;
  for (const piece of pieces) {
    const at = order.get(piece);
    if (at === undefined || at <= last) return false;
    last = at;
  }
  return true;
}

export type PromptWordSource = "typed" | "learned" | "picked";

/**
 * What Whisper's prompt holds for `project`, word by word with where each came from — what
 * Settings → Voice shows under "What Whisper hears first".
 */
export function whisperPromptPreview(
  config: VoiceMessageConfig,
  project: string,
  opts: { selfLearning: boolean; auto: readonly RankedTerm[] },
): Array<{ word: string; source: PromptWordSource }> {
  const lists = composeVoiceWords(config, project, opts);
  const own = projectWordsOf(config, project);
  const typed = new Set([...own.words, ...config.words].map((w) => w.toLowerCase()));
  const picked = new Set(opts.auto.map((t) => t.term.toLowerCase()));
  return whisperPromptWords(lists.whisper).map((word) => {
    const key = word.toLowerCase();
    return { word, source: typed.has(key) ? "typed" : picked.has(key) && !own.learned.some((l) => l.word.toLowerCase() === key) ? "picked" : "learned" };
  });
}
