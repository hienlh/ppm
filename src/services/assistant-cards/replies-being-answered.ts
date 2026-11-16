/**
 * The replies a turn of a chat is answering right now, whichever way the user wrote: a reply to one
 * of the Assistant's cards, or words about a task sent from Telegram. Everything that treats a card
 * a manager makes during that turn as the answer (threading it under the user's message, letting it
 * ring through quiet hours, telling the Assistant the user already has it) asks this, so both kinds
 * of message get the same treatment.
 */
import type { AnsweredReply } from "./card-reply-followup-tracker.ts";
import { cardReplyFollowups } from "./card-reply-followup.ts";
import { taskWordsFollowups } from "./task-words-followup.ts";

export function repliesBeingAnswered(sessionId: string | null): AnsweredReply[] {
  return [...cardReplyFollowups.answering(sessionId), ...taskWordsFollowups.answering(sessionId)];
}
