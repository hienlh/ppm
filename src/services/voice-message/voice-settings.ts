/**
 * The `voice_message` config row: on/off, "read the transcript before it is sent", the clean-up
 * and self-learning switches, and the word lists Whisper and the clean-up are given. Everything
 * read from the row goes through {@link normalizeVoiceConfig}, because the row is user data that a
 * CLI, an older build or a hand edit may have left in any shape.
 *
 * What the learning writes into a project's lists (learned words, candidates, undone words) lives
 * in `voice-learned-store.ts`; this file only reads, cleans and applies Settings' changes.
 */
import { configService } from "../config.service.ts";
import type {
  BlockedWord, LearnedWord, VoiceCandidate, VoiceMessageConfig, VoiceProjectWords,
} from "../../shared/voice-message.ts";

export const VOICE_LIMITS = {
  /** Words kept for every project. */
  globalWords: 300,
  /** Words the user typed for one project. */
  projectWords: 300,
  /** Corrections learned for one project; the newest are kept. */
  learned: 200,
  /** Corrections still being counted for one project; the most recently seen are kept. */
  candidates: 300,
  /** Undone words remembered for one project. */
  blocked: 200,
  /** Longest single word or phrase. */
  wordChars: 60,
  /** Longest project name a list may be stored under. */
  projectKeyChars: 200,
  /** Projects with a list; a row with more is cut rather than trusted. */
  projects: 1_000,
  maxHits: 9_999,
} as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const hitsOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 ? Math.min(v, VOICE_LIMITS.maxHits) : null;

/** One word as stored: whitespace collapsed and trimmed, 1–60 characters, else null. */
export function cleanWord(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const word = raw.replace(/\s+/g, " ").trim();
  return word.length >= 1 && word.length <= VOICE_LIMITS.wordChars ? word : null;
}

/** Valid words, each once (compared without case), in order, at most `max`. */
export function cleanWordList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const word = cleanWord(item);
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

/** Valid learned entries, each word once (the newest wins), the newest {@link VOICE_LIMITS.learned}. */
export function cleanLearnedList(raw: unknown): LearnedWord[] {
  if (!Array.isArray(raw)) return [];
  const byWord = new Map<string, LearnedWord>();
  for (const item of raw) {
    if (!isObj(item)) continue;
    const word = cleanWord(item.word);
    const from = cleanWord(item.from);
    const at = isoOrNull(item.at);
    if (!word || !from || !at) continue;
    const entry: LearnedWord = { word, from, at };
    if (item.source === "edit" || item.source === "cleanup") entry.source = item.source;
    const hits = hitsOf(item.hits);
    if (hits) entry.hits = hits;
    if (item.kind === "term" || item.kind === "phrase") entry.kind = item.kind;
    const key = word.toLowerCase();
    byWord.delete(key); // re-inserted last, so the order stays oldest → newest
    byWord.set(key, entry);
  }
  return [...byWord.values()].slice(-VOICE_LIMITS.learned);
}

/** Valid candidates, each from→to pair once, the most recently seen {@link VOICE_LIMITS.candidates}. */
export function cleanCandidateList(raw: unknown): VoiceCandidate[] {
  if (!Array.isArray(raw)) return [];
  const byPair = new Map<string, VoiceCandidate>();
  for (const item of raw) {
    if (!isObj(item)) continue;
    const from = cleanWord(item.from);
    const to = cleanWord(item.to);
    const hits = hitsOf(item.hits);
    const at = isoOrNull(item.at);
    if (!from || !to || !hits || !at || from.toLowerCase() === to.toLowerCase()) continue;
    const key = `${from.toLowerCase()}\u0000${to.toLowerCase()}`;
    byPair.delete(key);
    byPair.set(key, { from, to, hits, at });
  }
  return [...byPair.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-VOICE_LIMITS.candidates);
}

/** Valid undone words, each once (the newest wins), the newest {@link VOICE_LIMITS.blocked}. */
export function cleanBlockedList(raw: unknown): BlockedWord[] {
  if (!Array.isArray(raw)) return [];
  const byWord = new Map<string, BlockedWord>();
  for (const item of raw) {
    if (!isObj(item)) continue;
    const word = cleanWord(item.word);
    const from = cleanWord(item.from) ?? word;
    const at = isoOrNull(item.at);
    if (!word || !from || !at) continue;
    const entry: BlockedWord = { word, from, at };
    if (item.source === "edit" || item.source === "cleanup") entry.source = item.source;
    const hits = hitsOf(item.hits);
    if (hits) entry.hits = hits;
    if (item.kind === "term" || item.kind === "phrase") entry.kind = item.kind;
    byWord.delete(word.toLowerCase());
    byWord.set(word.toLowerCase(), entry);
  }
  return [...byWord.values()].slice(-VOICE_LIMITS.blocked);
}

function cleanProjectWords(value: Record<string, unknown>): VoiceProjectWords {
  const out: VoiceProjectWords = { words: cleanWordList(value.words, VOICE_LIMITS.projectWords), learned: cleanLearnedList(value.learned) };
  const candidates = cleanCandidateList(value.candidates);
  if (candidates.length) out.candidates = candidates;
  const blocked = cleanBlockedList(value.blocked);
  if (blocked.length) out.blocked = blocked;
  return out;
}

function cleanProjects(raw: unknown): Record<string, VoiceProjectWords> {
  const out: Record<string, VoiceProjectWords> = {};
  if (!isObj(raw)) return out;
  let count = 0;
  for (const [name, value] of Object.entries(raw)) {
    // "__proto__" as a plain assignment would replace the object's prototype instead of adding a key.
    if (!name.trim() || name === "__proto__" || name.length > VOICE_LIMITS.projectKeyChars || !isObj(value)) continue;
    out[name] = cleanProjectWords(value);
    if (++count >= VOICE_LIMITS.projects) break;
  }
  return out;
}

/** The stored row in a shape every reader can trust; anything missing takes its default. */
export function normalizeVoiceConfig(raw: unknown): VoiceMessageConfig {
  const value = isObj(raw) ? raw : {};
  const config: VoiceMessageConfig = {
    review_before_send: value.review_before_send !== false,
    cleanup_enabled: value.cleanup_enabled !== false,
    learn_auto_vocabulary: value.learn_auto_vocabulary !== false,
    learn_from_cleanup: value.learn_from_cleanup !== false,
    weekly_summary: value.weekly_summary !== false,
    vietnamese_fixes: value.vietnamese_fixes !== false,
    words: cleanWordList(value.words, VOICE_LIMITS.globalWords),
    projects: cleanProjects(value.projects),
  };
  if (typeof value.enabled === "boolean") config.enabled = value.enabled;
  if (typeof value.self_learning === "boolean") config.self_learning = value.self_learning;
  return config;
}

export function readVoiceSettings(): VoiceMessageConfig {
  return normalizeVoiceConfig(configService.get("voice_message"));
}

export function writeVoiceSettings(config: VoiceMessageConfig): VoiceMessageConfig {
  const normalized = normalizeVoiceConfig(config);
  configService.set("voice_message", normalized);
  return normalized;
}

/** The feature is on only once somebody turned it on; not chosen yet counts as off. */
export function voiceMessagesEnabled(): boolean {
  return readVoiceSettings().enabled === true;
}

/** Self-learning runs only inside a switched-on voice feature, and only once somebody chose it. */
export function selfLearningOn(config: VoiceMessageConfig): boolean {
  return config.enabled === true && config.self_learning === true;
}

export function projectWordsOf(config: VoiceMessageConfig, project: string): VoiceProjectWords {
  // Own keys only: a project named "constructor" or "toString" would otherwise get Object's member.
  return Object.hasOwn(config.projects, project) ? config.projects[project]! : { words: [], learned: [] };
}

/** Every word the user gave or PPM learned for `project`: its own, what it learned, then everyone's. */
export function vocabularyOf(config: VoiceMessageConfig, project: string): string[] {
  const own = projectWordsOf(config, project);
  return [...own.words, ...own.learned.map((l) => l.word), ...config.words];
}

/** A change from Settings → Voice. Fields left out stay as they are. */
export interface VoiceSettingsPatch {
  enabled?: boolean;
  reviewBeforeSend?: boolean;
  cleanupEnabled?: boolean;
  selfLearning?: boolean;
  learnAutoVocabulary?: boolean;
  learnFromCleanup?: boolean;
  weeklySummary?: boolean;
  vietnameseFixes?: boolean;
  words?: string[];
  /** Required for `projectWords`, `removeLearned` and `restoreBlocked`. */
  project?: string;
  projectWords?: string[];
  /** Learned words to undo, matched without case: dropped and never learned again from the clean-up. */
  removeLearned?: string[];
  /** Undone words to bring back as learned words. */
  restoreBlocked?: string[];
}

const SWITCHES = [
  ["enabled", "enabled"], ["reviewBeforeSend", "review_before_send"], ["cleanupEnabled", "cleanup_enabled"],
  ["selfLearning", "self_learning"], ["learnAutoVocabulary", "learn_auto_vocabulary"],
  ["learnFromCleanup", "learn_from_cleanup"], ["weeklySummary", "weekly_summary"], ["vietnameseFixes", "vietnamese_fixes"],
] as const satisfies ReadonlyArray<readonly [keyof VoiceSettingsPatch, keyof VoiceMessageConfig]>;

export function updateVoiceSettings(patch: VoiceSettingsPatch, now = new Date()): VoiceMessageConfig {
  const config = readVoiceSettings();
  for (const [from, to] of SWITCHES) {
    const value = patch[from];
    if (typeof value === "boolean") (config as unknown as Record<string, boolean>)[to] = value;
  }
  if (patch.words) config.words = cleanWordList(patch.words, VOICE_LIMITS.globalWords);
  const project = patch.project;
  if (project && (patch.projectWords || patch.removeLearned || patch.restoreBlocked)) {
    const own = projectWordsOf(config, project);
    const words = patch.projectWords ? cleanWordList(patch.projectWords, VOICE_LIMITS.projectWords) : own.words;
    const drop = new Set((patch.removeLearned ?? []).map((w) => String(w).trim().toLowerCase()));
    const restore = new Set((patch.restoreBlocked ?? []).map((w) => String(w).trim().toLowerCase()));
    const undone = own.learned.filter((l) => drop.has(l.word.toLowerCase()));
    const at = now.toISOString();
    const blocked = [
      ...(own.blocked ?? []).filter((b) => !restore.has(b.word.toLowerCase())),
      ...undone.map((l): BlockedWord => ({ ...l, at })),
    ];
    const restored = (own.blocked ?? []).filter((b) => restore.has(b.word.toLowerCase()))
      .map((b): LearnedWord => ({ ...b, at }));
    const learned = [...own.learned.filter((l) => !drop.has(l.word.toLowerCase())), ...restored];
    // An undone correction stops being counted too, or the next message would learn it straight back.
    const candidates = (own.candidates ?? []).filter((c) => !drop.has(c.to.toLowerCase()));
    config.projects = { ...config.projects, [project]: { ...own, words, learned, candidates, blocked } };
  }
  return writeVoiceSettings(config);
}
