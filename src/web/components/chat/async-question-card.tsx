import { createContext, useContext } from "react";
import type { ChatMessage } from "../../../types/chat";
import { formatQuestionReply, questionReplyPrefix, type ChatQuestion } from "../../../shared/chat-questions";
import type { AnswersById, NormalizedQuestion } from "../../../shared/approval-questions";
import { QuestionCard } from "./question-card";

export const AsyncQuestionContext = createContext<{
  messages: ChatMessage[];
  onSend?: (content: string) => void;
}>({ messages: [] });

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
  const { messages, onSend } = useContext(AsyncQuestionContext);
  const prefix = questionReplyPrefix(itemId);
  const reply = messages.find((message) => message.role === "user" && message.content.startsWith(prefix));
  if (reply || !onSend) return (
    <div className="rounded-lg border border-border bg-surface p-3 text-sm whitespace-pre-wrap">
      {reply ? reply.content.slice(prefix.length) : questions.map((question) => question.question).join("\n")}
      <div className="mt-2 text-xs text-text-secondary">{reply ? "Response sent" : "Connect to answer this question"}</div>
    </div>
  );
  return <QuestionCard questions={questions.map(toCardQuestion)} autoFocus={false}
    onSubmit={(answers) => onSend(formatQuestionReply(itemId, questions, joinedAnswers(answers)))}
    onSkip={() => onSend(formatQuestionReply(itemId, questions))} />;
}
