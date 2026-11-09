export interface ChatQuestion {
  id?: string;
  question: string;
  header?: string;
  /** `preview`: optional text (a plan, a mockup, a snippet) Claude attaches to an option. Claude
   *  Code shows it beside the list, and Claude writes "see the panel next to the options" — so a
   *  card that drops it leaves the user answering a question about content they never saw. */
  options: { label: string; description?: string; preview?: string }[];
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
