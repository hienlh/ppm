/**
 * Which of the bot's Telegram messages are the PPM Assistant's own answers, and whether the turn
 * that wrote each one stayed clear of outside text. The bot sends much else — a watched chat's
 * report, another chat's approval card, a database notice, picture captions, the backlog question,
 * `/sessions` titles — and all of that is someone else's text, so a reply that quotes a bot message
 * counts it as the Assistant's own words only when it is recorded here.
 *
 * Kept in memory and bounded: after a restart, or past the bound, an old answer is quoted as a
 * PPM message of unknown origin, which is the cautious side.
 */

/** How many answer messages are remembered, oldest forgotten first. */
export const OWN_ANSWERS_MAX = 5000;

/**
 * The turn an answer came from. Shared by every message of that turn, and turned untrusted in
 * place the moment the turn is: a page already sent stops counting as clean too.
 */
export interface AnswerTurn {
  sessionId: string;
  trusted: boolean;
}

const answers = new Map<string, AnswerTurn>();
const key = (chatId: string, messageId: number): string => `${chatId}:${messageId}`;

/** A message the turn renderer sent for `turn`. */
export function recordAnswerMessage(chatId: string, messageId: number, turn: AnswerTurn): void {
  answers.delete(key(chatId, messageId));
  answers.set(key(chatId, messageId), turn);
  while (answers.size > OWN_ANSWERS_MAX) answers.delete(answers.keys().next().value!);
}

/** The turn that wrote this message of this chat, when it is one of the Assistant's answers. */
export function answerMessage(chatId: string, messageId: number): AnswerTurn | null {
  return answers.get(key(chatId, messageId)) ?? null;
}

/** A session moved to a new id: its answers belong to the new one. */
export function renameAnswerSession(from: string, to: string): void {
  for (const turn of new Set(answers.values())) if (turn.sessionId === from) turn.sessionId = to;
}

/** Tests only. */
export function clearOwnAnswers(): void {
  answers.clear();
}
