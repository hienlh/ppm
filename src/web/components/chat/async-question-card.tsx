import { createContext, useContext } from "react";
import type { ChatMessage } from "../../../types/chat";
import { formatQuestionReply, questionReplyPrefix, type ChatQuestion } from "../../../shared/chat-questions";
import { QuestionCard } from "./question-card";

export const AsyncQuestionContext = createContext<{
  messages: ChatMessage[];
  onSend?: (content: string) => void;
}>({ messages: [] });

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
  return <QuestionCard questions={questions} autoFocus={false}
    onSubmit={(answers) => onSend(formatQuestionReply(itemId, questions, answers))}
    onSkip={() => onSend(formatQuestionReply(itemId, questions))} />;
}
