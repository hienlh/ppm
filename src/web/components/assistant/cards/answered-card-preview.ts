/**
 * What a folded answered card shows of the conversation under it, so it can be read without
 * opening: one line of the user's reply and the first lines of the manager's answer, both as plain
 * text. Pure, so it is tested without drawing the card.
 */
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CARD_ANSWER_PREVIEW_CHARS, markdownPreview } from "../../../../shared/plain-text-preview";

export interface AnsweredCardPreview {
  /** The start of the user's reply, as the server kept it; empty when it kept none. */
  reply: string;
  /** The start of the manager's answer, or the card it answered with; empty when there is neither. */
  answer: string;
}

/** The preview of a card's follow-up; null when the manager has not answered (or said nothing). */
export function answeredCardPreview(card: Pick<AssistantCard, "followUp">): AnsweredCardPreview | null {
  const f = card.followUp;
  if (!f) return null;
  const reply = f.reply?.trim() ?? "";
  let answer: string;
  if (f.newCards?.length) {
    // The new card is the answer: its title says what the manager asked or decided.
    const [first, ...rest] = f.newCards;
    answer = `New card: “${first!.title}”${rest.length ? ` and ${rest.length} more` : ""}`;
  } else {
    answer = markdownPreview(f.text, CARD_ANSWER_PREVIEW_CHARS);
    // The kept answer was cut already (the rest is in the manager chat): say so when this did not.
    if (answer && f.truncated && !answer.endsWith("…")) answer = `${answer.replace(/[\s.,;:!?·-]+$/u, "")}…`;
  }
  return reply || answer ? { reply, answer } : null;
}
