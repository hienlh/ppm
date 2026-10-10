/**
 * One shape for a question an AI asks the user, whichever provider asked it, and one shape for
 * the answer.
 *
 * Claude's AskUserQuestion puts `questions` in the tool input and wants the answers keyed by the
 * question's own text, several choices joined with ", ". Codex's `item/tool/requestUserInput`
 * sends questions with an `id` each (single choice, an optional free-text "other", sometimes a
 * secret) and wants `{ [id]: { answers: string[] } }`. A card shown anywhere other than the
 * chat that asked — Telegram, the Assistant's `chat_answer_approval`, the web form — reads the
 * normalized questions and answers by question id; the server alone turns that into what the
 * provider expects (`toProviderAnswers`), so no surface needs to know which provider asked.
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface NormalizedQuestion {
  /** Stable within the card: Codex's own id, or `q<n>` for Claude, which gives none. */
  id: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  /** More than one option may be chosen. */
  multiSelect: boolean;
  /** The user may type an answer of their own instead of (or, with no options, as) a choice. */
  allowsFreeText: boolean;
  /** The typed answer is a secret (Codex `isSecret`): never echo it where others could read it. */
  secret?: boolean;
}

/** The user's answers: question id → the chosen labels or typed text (one entry unless multiSelect). */
export type AnswersById = Record<string, string[]>;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function options(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionOption[] = [];
  for (const o of raw) {
    if (!isRecord(o) || typeof o.label !== "string" || !o.label) continue;
    const description = str(o.description);
    out.push({ label: o.label, ...(description ? { description } : {}) });
  }
  return out;
}

/** Claude's AskUserQuestion input (`{ questions: [{ question, header, options, multiSelect }] }`). */
export function normalizeClaudeQuestions(input: unknown): NormalizedQuestion[] {
  const raw = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  const out: NormalizedQuestion[] = [];
  raw.forEach((q, i) => {
    if (!isRecord(q) || typeof q.question !== "string") return;
    const header = str(q.header);
    out.push({
      // Index-based so the id survives a question text that repeats another's.
      id: `q${i + 1}`,
      question: q.question,
      ...(header ? { header } : {}),
      options: options(q.options),
      multiSelect: q.multiSelect === true,
      // Claude's tool always takes a typed answer beside its choices.
      allowsFreeText: true,
    });
  });
  return out;
}

/**
 * Codex's `item/tool/requestUserInput` params, read from the request as received — never from
 * the capped string an older card carried, which cut long questions and options off.
 */
export function normalizeCodexQuestions(rawParams: unknown): NormalizedQuestion[] {
  const raw = isRecord(rawParams) && Array.isArray(rawParams.questions) ? rawParams.questions : [];
  const out: NormalizedQuestion[] = [];
  const seen = new Set<string>();
  raw.forEach((q, i) => {
    if (!isRecord(q) || typeof q.question !== "string") return;
    // The same fallback the provider uses to key its answer, so both sides name it alike.
    const id = str(q.id) || str(q.questionId) || String(i);
    if (seen.has(id)) return;
    seen.add(id);
    const opts = options(q.options);
    const header = str(q.header);
    out.push({
      id,
      question: q.question,
      ...(header ? { header } : {}),
      options: opts,
      multiSelect: false,
      allowsFreeText: q.isOther === true || opts.length === 0,
      ...(q.isSecret === true ? { secret: true } : {}),
    });
  });
  return out;
}

/** Normalized questions off the wire (an event, a greeting), or undefined when not that shape. */
export function questionsFromWire(raw: unknown): NormalizedQuestion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: NormalizedQuestion[] = [];
  for (const q of raw) {
    if (!isRecord(q) || typeof q.id !== "string" || typeof q.question !== "string") return undefined;
    const header = str(q.header);
    out.push({
      id: q.id,
      question: q.question,
      ...(header ? { header } : {}),
      options: options(q.options),
      multiSelect: q.multiSelect === true,
      allowsFreeText: q.allowsFreeText === true,
      ...(q.secret === true ? { secret: true } : {}),
    });
  }
  return out;
}

/** Strings only, empty ones dropped; anything else is not an answer. */
function answerList(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  return list.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
}

/**
 * Keeps only answers to questions on the card, as lists of non-empty strings. Lenient by
 * design: it is the server's last step before the provider, for input already checked (or a
 * browser's own form); callers taking answers from anywhere less trusted use
 * {@link answersByIdError} first.
 */
export function coerceAnswersById(questions: readonly NormalizedQuestion[], raw: unknown): AnswersById {
  const out: AnswersById = {};
  if (!isRecord(raw)) return out;
  for (const q of questions) {
    const list = answerList(raw[q.id]);
    if (list.length) out[q.id] = q.multiSelect ? list : list.slice(0, 1);
  }
  return out;
}

/**
 * Why `raw` is not a valid answer to `questions`, or null when it is: every key a question on
 * the card, every value a list of non-empty strings, one entry for a single-choice question, a
 * listed option unless the question takes typed text, and — with `requireAll` — every question
 * answered. Worded for the agent or person who sent it.
 */
export function answersByIdError(
  questions: readonly NormalizedQuestion[],
  raw: unknown,
  opts: { requireAll?: boolean } = {},
): string | null {
  if (!isRecord(raw)) return "Answers must be an object of question id → list of answers.";
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const [id, value] of Object.entries(raw)) {
    const q = byId.get(id);
    if (!q) return `"${id}" is not a question on this card (ids: ${questions.map((x) => x.id).join(", ") || "none"}).`;
    if (!Array.isArray(value) || value.some((a) => typeof a !== "string" || !a.trim())) {
      return `The answer to "${id}" must be a list of non-empty strings.`;
    }
    if (!q.multiSelect && value.length > 1) return `"${id}" takes one answer, not ${value.length}.`;
    if (!q.allowsFreeText) {
      const labels = new Set(q.options.map((o) => o.label));
      const bad = (value as string[]).find((a) => !labels.has(a));
      if (bad !== undefined) return `"${bad}" is not an option of "${id}" (options: ${q.options.map((o) => o.label).join(", ")}).`;
    }
  }
  if (opts.requireAll) {
    const missing = questions.filter((q) => answerList(raw[q.id]).length === 0);
    if (missing.length) return `Every question needs an answer; missing: ${missing.map((q) => q.id).join(", ")}.`;
  }
  return null;
}

/**
 * The answers an older browser tab sends — Claude's own shape, keyed by question text, several
 * choices joined with ", " — read back by id. A key may also be the id itself, and an array is
 * read by position (what the Codex provider accepted before ids were shared).
 */
export function legacyAnswersToById(questions: readonly NormalizedQuestion[], data: unknown): AnswersById {
  const out: AnswersById = {};
  if (Array.isArray(data)) {
    questions.forEach((q, i) => {
      const list = answerList(data[i]);
      if (list.length) out[q.id] = list;
    });
    return out;
  }
  if (!isRecord(data)) return out;
  for (const q of questions) {
    const list = answerList(q.question in data ? data[q.question] : data[q.id]);
    if (list.length) out[q.id] = list;
  }
  return out;
}

/**
 * How an answered card shows its answers, for every provider: keyed by question text, choices
 * joined with ", " — what the transcript's AskUserQuestion card has always read.
 */
export function answersForDisplay(questions: readonly NormalizedQuestion[], byId: AnswersById): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const list = byId[q.id];
    if (list?.length) out[q.question] = q.secret ? "(hidden)" : list.join(", ");
  }
  return out;
}

/**
 * The answer in the shape the asking provider takes. Codex: every question by id (an unanswered
 * one as an empty list, which is how it reads "skipped"). Claude and every other provider: the
 * AskUserQuestion shape, keyed by question text.
 */
export function toProviderAnswers(providerId: string, questions: readonly NormalizedQuestion[], byId: AnswersById): unknown {
  if (providerId === "codex") {
    const out: Record<string, string[]> = {};
    for (const q of questions) out[q.id] = byId[q.id] ?? [];
    return out;
  }
  const out: Record<string, string> = {};
  for (const q of questions) {
    const list = byId[q.id];
    if (list?.length) out[q.question] = list.join(", ");
  }
  return out;
}
