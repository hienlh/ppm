/**
 * What learning writes into a project's word lists in the `voice_message` row: corrections learned
 * from the user's edits, and the clean-up's replacements counted until they are learned. Undone
 * words (the `blocked` list) are skipped by the clean-up's learning; an edit by the user is an
 * explicit correction and lifts the block.
 */
import type { LearnedSource, LearnedWord, VoiceCandidate, VoiceMessageConfig } from "../../shared/voice-message.ts";
import { isFaded, isStaleCandidate, wordUsedIn } from "./voice-learned-fade.ts";
import { readyToLearn, type Replacement } from "./voice-learn-from-cleanup.ts";
import {
  candidateKey, cleanCandidateList, cleanLearnedList, projectWordsOf, readVoiceSettings, VOICE_LIMITS, vocabularyOf, writeVoiceSettings,
} from "./voice-settings.ts";

const validProject = (project: string) => !!project.trim() && project.length <= VOICE_LIMITS.projectKeyChars;

/**
 * Adds corrections learned from an edited transcript to `project`'s list and answers with the ones
 * that were new to it. A word already in any list (the project's own, its learned ones, everyone's)
 * is not added.
 */
export function appendLearnedWords(project: string, entries: readonly LearnedWord[]): LearnedWord[] {
  if (!validProject(project)) return [];
  const config = readVoiceSettings();
  const known = new Set(vocabularyOf(config, project).map((w) => w.toLowerCase()));
  const added: LearnedWord[] = [];
  for (const raw of entries) {
    const entry = cleanLearnedList([{ ...raw, source: "edit" }])[0];
    if (!entry || known.has(entry.word.toLowerCase())) continue;
    known.add(entry.word.toLowerCase());
    added.push(entry);
  }
  if (added.length === 0) return [];
  const own = projectWordsOf(config, project);
  const lifted = new Set(added.map((a) => a.word.toLowerCase()));
  config.projects = {
    ...config.projects,
    [project]: {
      ...own,
      learned: cleanLearnedList([...own.learned, ...added]),
      blocked: (own.blocked ?? []).filter((b) => !lifted.has(b.word.toLowerCase())),
    },
  };
  writeVoiceSettings(config);
  return added;
}


/**
 * Counts one message's replacements for `project` and learns those seen often enough. A
 * replacement whose word is already learned only bumps that word's count; one whose word the user
 * undid, or typed into a list themself, is not counted. `known` is the project's own text (its
 * picked-up words and its typed words), which lets a term be learned after two messages instead
 * of three — for the clean-up's corrections, not the chat's (`readyToLearn`). `source` is what a
 * newly learned word is marked as, and the clean-up and the chat are counted apart. For the chat,
 * `chatId` names the chat that read it: a chat counts once per pair, since within one
 * conversation the AI sees and repeats its own earlier reading. Answers with the words learned.
 */
export function recordCleanupReplacements(
  project: string,
  found: readonly Replacement[],
  known: ReadonlySet<string>,
  now = new Date(),
  source: Extract<LearnedSource, "cleanup" | "chat"> = "cleanup",
  chatId?: string,
): LearnedWord[] {
  if (!validProject(project) || found.length === 0) return [];
  const config: VoiceMessageConfig = readVoiceSettings();
  const own = projectWordsOf(config, project);
  const at = now.toISOString();
  const blocked = new Set((own.blocked ?? []).map((b) => b.word.toLowerCase()));
  const typed = new Set([...own.words, ...config.words].map((w) => w.toLowerCase()));
  const learned = [...own.learned];
  const learnedAt = new Map(learned.map((l, i) => [l.word.toLowerCase(), i]));
  const candidates = new Map<string, VoiceCandidate>((own.candidates ?? []).map((c) => [candidateKey(c), c]));
  const chatSource = source === "chat" ? { source: "chat" as const } : {};
  const newlyLearned: LearnedWord[] = [];
  const seenThisMessage = new Set<string>();

  for (const r of found) {
    const word = r.to.toLowerCase();
    const key = candidateKey({ from: r.from, to: r.to, ...chatSource });
    if (seenThisMessage.has(key) || blocked.has(word) || typed.has(word)) continue;
    seenThisMessage.add(key);
    const index = learnedAt.get(word);
    if (index !== undefined) {
      const entry = learned[index]!;
      learned[index] = { ...entry, hits: Math.min((entry.hits ?? 1) + 1, VOICE_LIMITS.maxHits), lastUsedAt: at };
      continue;
    }
    const previous = candidates.get(key);
    // The same chat reading the same pair again is one reading, not another.
    if (source === "chat" && chatId && previous?.chats?.includes(chatId)) continue;
    const chats = source === "chat" && chatId ? [...(previous?.chats ?? []), chatId].slice(-VOICE_LIMITS.candidateChats) : undefined;
    const hits = (previous?.hits ?? 0) + 1;
    if (readyToLearn(r, hits, known, source)) {
      const entry: LearnedWord = { word: r.to, from: r.from, at, source, hits, kind: r.kind };
      learned.push(entry);
      learnedAt.set(word, learned.length - 1);
      candidates.delete(key);
      newlyLearned.push(entry);
    } else {
      candidates.set(key, { from: r.from, to: r.to, hits, at, ...chatSource, ...(chats ? { chats } : {}) });
    }
  }

  config.projects = {
    ...config.projects,
    [project]: { ...own, learned: cleanLearnedList(learned), candidates: cleanCandidateList([...candidates.values()]) },
  };
  writeVoiceSettings(config);
  return newlyLearned;
}

/**
 * After a voice message: every learned word of `project` that the transcript says (as heard or as
 * cleaned) is marked used now, then the words the clean-up taught that have gone unused for the
 * fade window leave the list, and so do candidates not seen in that time. Answers with the words
 * that faded. Writes only when something changed.
 */
export function markLearnedUse(project: string, texts: readonly string[], now = new Date()): LearnedWord[] {
  if (!validProject(project)) return [];
  const config = readVoiceSettings();
  if (!Object.hasOwn(config.projects, project)) return [];
  const own = projectWordsOf(config, project);
  const at = now.toISOString();
  const nowMs = now.getTime();
  let changed = false;
  const used = own.learned.map((l) => {
    if (!texts.some((t) => wordUsedIn(t, l.word))) return l;
    changed = true;
    return { ...l, lastUsedAt: at };
  });
  const faded = used.filter((l) => isFaded(l, nowMs));
  const candidates = (own.candidates ?? []).filter((c) => !isStaleCandidate(c, nowMs));
  if (faded.length || candidates.length !== (own.candidates ?? []).length) changed = true;
  if (!changed) return [];
  config.projects = {
    ...config.projects,
    [project]: { ...own, learned: used.filter((l) => !isFaded(l, nowMs)), candidates },
  };
  writeVoiceSettings(config);
  return faded;
}
