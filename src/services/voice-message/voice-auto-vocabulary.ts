/**
 * The words a project is likely to be spoken with, picked out of text PPM already holds — the
 * project's name, its recent task codes and titles, its chat titles and its CLAUDE.md terms — so
 * Whisper and the clean-up know them without anybody typing a word list. Nothing here reads a file
 * or a database: the sources arrive as strings and come back ranked.
 *
 * Two strengths of term. A strong one is something Whisper has no way to spell on its own — a name
 * or identifier with an inner capital, a digit or an inner dot/dash, an acronym, a task code
 * (ppm/53, NX-2231), a project's name — and only strong terms go into Whisper's prompt. A weak one
 * is a plain English word (worktree, staging): the clean-up gets those too, but Whisper writes
 * them fine already and they would only crowd its 600 characters.
 *
 * Vietnamese is never kept. A word with a Vietnamese letter is plainly Vietnamese; a plain word
 * from a Vietnamese sentence (trong, theo, giao) is too, however English it looks, so a sentence
 * that has any Vietnamese letter offers only its strong terms.
 */

/** Text a project offers, already read. Every field is optional so a missing source costs nothing. */
export interface VocabularySources {
  projectNames?: readonly string[];
  /** `ppm/53`, `NX-2231`: the codes of recently touched tasks, newest first. */
  taskCodes?: readonly string[];
  taskTitles?: readonly string[];
  chatTitles?: readonly string[];
  /** Terms already reduced from CLAUDE.md (backticked identifiers and heading words). */
  instructionTerms?: readonly string[];
  /** Free text the Assistant keeps (its notebook). */
  notes?: readonly string[];
}

export interface RankedTerm { term: string; score: number; strong: boolean }

/** How much one sighting in each source counts. A project's own name is what people say most. */
const WEIGHTS = { projectName: 20, taskCode: 6, taskTitle: 3, chatTitle: 2, instructionTerm: 1, note: 1 } as const;
/** A plain word counts this share of a strong term seen the same way. */
const WEAK_SHARE = 0.5;

export const AUTO_VOCABULARY_LIMITS = {
  /** Terms kept for the clean-up; Whisper takes the strong ones that fit its 600 characters. */
  words: 150,
  termChars: 30,
  /** Task codes at most: a code is only worth its characters while the task is talked about. */
  taskCodes: 8,
} as const;

/** Everyday English words that fill titles and are no harder for Whisper than any other. */
const STOPWORDS = new Set(`a an and are as at be but by can do does for from has have how if in into is it its
 no not of off on or our out so than that the then this to up was we what when where which who why will with
 you your all any add adds added new old one two more most less some via use used uses using make makes get gets
 set sets show shows read reads run runs keep keeps open opens fix fixes fixed only also just after before again
 still here there now each every same other others own way ways yes don't can't it's let lets per about over
 under between without while onto them they their there's what's should could would must may might need needs
 needed want wants first last next back time times day days week weeks year item items thing things work works
 done ready start started stop stopped page pages list lists text file files user users chat chats task tasks
 note notes step steps test tests check checks change changes waiting deployed release support settings
 production proposal review update updates`.split(/\s+/).filter(Boolean));

/** Letters Vietnamese writes and English does not: a word with one of them is Vietnamese. */
const VIETNAMESE_LETTER = /[à-ỹÀ-Ỹđ]/u;
const TASK_CODE = /^[A-Za-z][\w.-]*\/\d+$|^[A-Z][A-Z0-9]+-\d+$/;

/** One token as it may be kept, with its strength, or null. Surrounding punctuation is dropped first. */
export function termOf(raw: string): { term: string; strong: boolean } | null {
  const token = raw.replace(/^[\s"'`([{<*_~]+|[\s"'`)\]}>*_~.,:;!?…]+$/gu, "");
  if (token.length < 2 || token.length > AUTO_VOCABULARY_LIMITS.termChars) return null;
  if (TASK_CODE.test(token)) return { term: token, strong: true };
  if (token.includes("/") || /[\\@#$%^&=|<>{}()[\]]/.test(token)) return null;
  if (!/\p{L}/u.test(token) || VIETNAMESE_LETTER.test(token)) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}.+_'-]*$/u.test(token)) return null;
  if (STOPWORDS.has(token.toLowerCase())) return null;
  // An inner capital, a digit or an inner dot/dash: a name, an acronym or an identifier.
  if (/\p{Lu}/u.test(token.slice(1)) || /\d/.test(token) || /[.+_-]/.test(token.slice(1, -1))) return { term: token, strong: true };
  return token.length >= 4 ? { term: token, strong: false } : null;
}

/**
 * The terms in a piece of free text, in order. A text with any Vietnamese letter in it offers
 * only its strong terms: its plain words are Vietnamese written without marks.
 */
export function termsInText(text: string): Array<{ term: string; strong: boolean }> {
  const vietnamese = VIETNAMESE_LETTER.test(text);
  const out: Array<{ term: string; strong: boolean }> = [];
  for (const raw of text.split(/[\s,;:!?…"“”()[\]{}<>|]+/u)) {
    const found = termOf(raw);
    if (found && (found.strong || !vietnamese)) out.push(found);
  }
  return out;
}

/**
 * The sources ranked into one list: every term scored by where and how often it was seen, the
 * highest first (ties keep the order they were first seen in), each once without regard to case.
 * The spelling kept is the one seen with the most weight, so "ppm" in a title never beats "PPM"
 * as the project's own name.
 */
export function rankVocabulary(sources: VocabularySources, max: number = AUTO_VOCABULARY_LIMITS.words): RankedTerm[] {
  const scores = new Map<string, { score: number; order: number; strong: boolean; spellings: Map<string, number> }>();
  let order = 0;
  const add = (found: { term: string; strong: boolean } | null, weight: number) => {
    if (!found) return;
    const key = found.term.toLowerCase();
    let entry = scores.get(key);
    if (!entry) { entry = { score: 0, order: order++, strong: false, spellings: new Map() }; scores.set(key, entry); }
    const w = found.strong ? weight : weight * WEAK_SHARE;
    entry.score += w;
    entry.strong ||= found.strong;
    entry.spellings.set(found.term, (entry.spellings.get(found.term) ?? 0) + w);
  };
  for (const name of sources.projectNames ?? []) {
    const whole = name.replace(/\s+/g, " ").trim();
    if (whole && whole.length <= AUTO_VOCABULARY_LIMITS.termChars && !VIETNAMESE_LETTER.test(whole)) add({ term: whole, strong: true }, WEIGHTS.projectName);
  }
  for (const code of (sources.taskCodes ?? []).slice(0, AUTO_VOCABULARY_LIMITS.taskCodes)) {
    if (TASK_CODE.test(code)) add({ term: code, strong: true }, WEIGHTS.taskCode);
  }
  for (const title of sources.taskTitles ?? []) for (const t of termsInText(title)) add(t, WEIGHTS.taskTitle);
  for (const title of sources.chatTitles ?? []) for (const t of termsInText(title)) add(t, WEIGHTS.chatTitle);
  for (const term of sources.instructionTerms ?? []) add(termOf(term), WEIGHTS.instructionTerm);
  for (const note of sources.notes ?? []) for (const t of termsInText(note)) add(t, WEIGHTS.note);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map((e) => ({ term: [...e.spellings.entries()].sort((a, b) => b[1] - a[1])[0]![0], score: e.score, strong: e.strong }));
}

/**
 * CLAUDE.md reduced to its spoken-like terms: the backticked ones and the words of its headings.
 * Fenced code is skipped. Terms come back as text; {@link rankVocabulary} judges them again.
 */
export function instructionTermsOf(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) out.push(...termsInText(heading[1]!.replace(/`/g, "")).map((t) => t.term));
    for (const m of line.matchAll(/`([^`\n]{1,40})`/g)) {
      const found = termOf(m[1]!);
      if (found) out.push(found.term);
    }
  }
  return out;
}
