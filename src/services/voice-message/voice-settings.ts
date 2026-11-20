/**
 * The `voice_message` config row: on/off, "read the transcript before it is sent", and the word
 * lists Whisper and the clean-up are given. Everything read from the row goes through
 * {@link normalizeVoiceConfig}, because the row is user data that a CLI, an older build or a hand
 * edit may have left in any shape.
 */
import { configService } from "../config.service.ts";
import type { LearnedWord, VoiceMessageConfig, VoiceProjectWords } from "../../shared/voice-message.ts";

export const VOICE_LIMITS = {
  /** Words kept for every project. */
  globalWords: 300,
  /** Words the user typed for one project. */
  projectWords: 300,
  /** Corrections learned for one project; the newest are kept. */
  learned: 200,
  /** Longest single word or phrase. */
  wordChars: 60,
  /** Longest project name a list may be stored under. */
  projectKeyChars: 200,
  /** Projects with a list; a row with more is cut rather than trusted. */
  projects: 1_000,
} as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

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
    const at = typeof item.at === "string" && !Number.isNaN(Date.parse(item.at)) ? item.at : null;
    if (!word || !from || !at) continue;
    const key = word.toLowerCase();
    byWord.delete(key); // re-inserted last, so the order stays oldest → newest
    byWord.set(key, { word, from, at });
  }
  return [...byWord.values()].slice(-VOICE_LIMITS.learned);
}

function cleanProjects(raw: unknown): Record<string, VoiceProjectWords> {
  const out: Record<string, VoiceProjectWords> = {};
  if (!isObj(raw)) return out;
  let count = 0;
  for (const [name, value] of Object.entries(raw)) {
    // "__proto__" as a plain assignment would replace the object's prototype instead of adding a key.
    if (!name.trim() || name === "__proto__" || name.length > VOICE_LIMITS.projectKeyChars || !isObj(value)) continue;
    out[name] = { words: cleanWordList(value.words, VOICE_LIMITS.projectWords), learned: cleanLearnedList(value.learned) };
    if (++count >= VOICE_LIMITS.projects) break;
  }
  return out;
}

/** The stored row in a shape every reader can trust; anything missing takes its default. */
export function normalizeVoiceConfig(raw: unknown): VoiceMessageConfig {
  const value = isObj(raw) ? raw : {};
  const config: VoiceMessageConfig = {
    review_before_send: value.review_before_send !== false,
    words: cleanWordList(value.words, VOICE_LIMITS.globalWords),
    projects: cleanProjects(value.projects),
  };
  if (typeof value.enabled === "boolean") config.enabled = value.enabled;
  return config;
}

export function readVoiceSettings(): VoiceMessageConfig {
  return normalizeVoiceConfig(configService.get("voice_message"));
}

/** The feature is on only once somebody turned it on; not chosen yet counts as off. */
export function voiceMessagesEnabled(): boolean {
  return readVoiceSettings().enabled === true;
}

export function projectWordsOf(config: VoiceMessageConfig, project: string): VoiceProjectWords {
  // Own keys only: a project named "constructor" or "toString" would otherwise get Object's member.
  return Object.hasOwn(config.projects, project) ? config.projects[project]! : { words: [], learned: [] };
}

/** Every word that may help with `project`: its own, what it learned, then everyone's. */
export function vocabularyOf(config: VoiceMessageConfig, project: string): string[] {
  const own = projectWordsOf(config, project);
  return [...own.words, ...own.learned.map((l) => l.word), ...config.words];
}

/** A change from Settings → Voice. Fields left out stay as they are. */
export interface VoiceSettingsPatch {
  enabled?: boolean;
  reviewBeforeSend?: boolean;
  words?: string[];
  /** Required for `projectWords` and `removeLearned`. */
  project?: string;
  projectWords?: string[];
  /** Learned words to forget, matched without case. */
  removeLearned?: string[];
}

export function updateVoiceSettings(patch: VoiceSettingsPatch): VoiceMessageConfig {
  const config = readVoiceSettings();
  if (typeof patch.enabled === "boolean") config.enabled = patch.enabled;
  if (typeof patch.reviewBeforeSend === "boolean") config.review_before_send = patch.reviewBeforeSend;
  if (patch.words) config.words = cleanWordList(patch.words, VOICE_LIMITS.globalWords);
  const project = patch.project;
  if (project && (patch.projectWords || patch.removeLearned)) {
    const own = projectWordsOf(config, project);
    const words = patch.projectWords ? cleanWordList(patch.projectWords, VOICE_LIMITS.projectWords) : own.words;
    const drop = new Set((patch.removeLearned ?? []).map((w) => String(w).trim().toLowerCase()));
    const learned = own.learned.filter((l) => !drop.has(l.word.toLowerCase()));
    config.projects = { ...config.projects, [project]: { words, learned } };
  }
  const normalized = normalizeVoiceConfig(config);
  configService.set("voice_message", normalized);
  return normalized;
}

/**
 * Adds learned corrections to `project`'s list and answers with the ones that were new to it.
 * A word already in any list (the project's own, its learned ones, everyone's) is not added.
 */
export function appendLearnedWords(project: string, entries: readonly LearnedWord[]): LearnedWord[] {
  if (!project.trim() || project.length > VOICE_LIMITS.projectKeyChars) return [];
  const config = readVoiceSettings();
  const known = new Set(vocabularyOf(config, project).map((w) => w.toLowerCase()));
  const added: LearnedWord[] = [];
  for (const raw of entries) {
    const entry = cleanLearnedList([raw])[0];
    if (!entry || known.has(entry.word.toLowerCase())) continue;
    known.add(entry.word.toLowerCase());
    added.push(entry);
  }
  if (added.length === 0) return [];
  const own = projectWordsOf(config, project);
  config.projects = { ...config.projects, [project]: { words: own.words, learned: cleanLearnedList([...own.learned, ...added]) } };
  configService.set("voice_message", normalizeVoiceConfig(config));
  return added;
}
