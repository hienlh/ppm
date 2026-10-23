export interface ChatQuestion {
  id?: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export const ASYNC_QUESTION_TOOL = "RequestUserInput";

export function questionReplyPrefix(itemId: string): string {
  return `Answers to Codex question ${encodeURIComponent(itemId)}:\n`;
}

export function formatQuestionReply(itemId: string, questions: ChatQuestion[], answers?: Record<string, string>): string {
  return questionReplyPrefix(itemId) + (answers
    ? questions.map((question) => `${question.question}\n${answers[question.id ?? question.question] ?? ""}`).join("\n\n")
    : "Skipped by the user.");
}
