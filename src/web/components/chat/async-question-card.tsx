import { createContext, useContext, useState } from "react";
import type { ChatMessage } from "../../../types/chat";
import type { QueuedMessage } from "../../../shared/chat-queue";
import { formatQuestionReply, questionReplyPrefix, type ChatQuestion } from "../../../shared/chat-questions";
import type { AnswersById, NormalizedQuestion } from "../../../shared/approval-questions";
import { QuestionCard } from "./question-card";

export const AsyncQuestionContext = createContext<{
  messages: ChatMessage[];
  /** The session's queue: a reply waiting there has been given, so the card is closed. */
  queued?: QueuedMessage[];
  /** Sent mid-turn it is steered into the running turn at once (Send now), never left queued
   *  until the turn ends: the AI asked so it could act on the answer. */
  onSend?: (content: string) => void;
}>({ messages: [] });

/** Replies given in this page, by question item id. Module-level rather than component state: the
 *  card remounts whenever the turn's events regroup, and a remount before the reply reaches the
 *  conversation reopened the question, so each further click queued another answer. */
const sentReplies = new Map<string, string>();

/**
 * The card's shape for a question Codex asked in an agent message. Its id is the one
 * `formatQuestionReply` reads the answer under; such a question always takes a typed answer.
 */
function toCardQuestion(question: ChatQuestion): NormalizedQuestion {
  return {
    id: question.id ?? question.question,
    question: question.question,
    ...(question.header ? { header: question.header } : {}),
    options: question.options,
    multiSelect: !!question.multiSelect,
    allowsFreeText: true,
  };
}

/** The card's answers as `formatQuestionReply` takes them: several choices joined with ", ". */
function joinedAnswers(byId: AnswersById): Record<string, string> {
  return Object.fromEntries(Object.entries(byId).map(([id, list]) => [id, list.join(", ")]));
}

export function AsyncQuestionCard({ itemId, questions }: { itemId: string; questions: ChatQuestion[] }) {
  const { messages, queued, onSend } = useContext(AsyncQuestionContext);
  const [, rerender] = useState(0);
  const prefix = questionReplyPrefix(itemId);
  const reply = messages.find((message) => message.role === "user" && message.content.startsWith(prefix))?.content
    ?? queued?.find((entry) => entry.content.startsWith(prefix))?.content
    ?? sentReplies.get(itemId);
  if (reply || !onSend) return (
    <div className="rounded-lg border border-border bg-surface p-3 text-sm whitespace-pre-wrap">
      {reply ? reply.slice(prefix.length) : questions.map((question) => question.question).join("\n")}
      <div className="mt-2 text-xs text-text-secondary">{reply ? "Response sent" : "Connect to answer this question"}</div>
    </div>
  );
  const send = (content: string) => {
    sentReplies.set(itemId, content);
    rerender((n) => n + 1);
    onSend(content);
  };
  return <QuestionCard questions={questions.map(toCardQuestion)} autoFocus={false}
    onSubmit={(answers) => send(formatQuestionReply(itemId, questions, joinedAnswers(answers)))}
    onSkip={() => send(formatQuestionReply(itemId, questions))} />;
}
