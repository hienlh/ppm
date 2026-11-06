/**
 * What the agent is waiting on, shown over the history window just above the composer.
 *
 * While the window is up the live list is hidden and `inert`, and its trailing approval card and
 * any question the agent asked live there — so a turn running underneath could block on an answer
 * nobody can see or click. This block takes them out of the hidden list: the approval card is
 * rendered here instead of there (it holds form state, so it is drawn in one place only), and an
 * open question is drawn here as well, interactive, while its copy in the hidden list is not.
 * Answering a question sends a message, and a message sent from this tab returns to the live list.
 */
import type { PendingAsyncQuestion } from "@/lib/history-window-live-signals";
import { PendingApprovalCard } from "./message-approval-cards";
import { AsyncQuestionCard } from "./async-question-card";

export function HistoryWindowPendingPrompts({ approval, onRespond, question, pillDocked }: {
  approval: { requestId: string; tool: string; input: unknown } | null;
  onRespond: (requestId: string, approved: boolean, data?: unknown) => void;
  question: PendingAsyncQuestion | null;
  /** The Back to latest pill sits outside the window (phones), so this block can take the bottom. */
  pillDocked: boolean;
}) {
  if (!approval && !question) return null;
  return (
    <div
      data-window-pending=""
      role="region"
      aria-label="Waiting for your answer"
      className={`absolute inset-x-0 z-30 max-h-[60%] space-y-3 overflow-y-auto px-4 select-none ${pillDocked ? "bottom-3" : "bottom-[4.25rem]"}`}
    >
      {/* Opaque behind the cards: some are tinted washes, and the window's rows scroll beneath. */}
      {approval && <div className="rounded-lg bg-background shadow-lg"><PendingApprovalCard approval={approval} onRespond={onRespond} /></div>}
      {question && <div className="rounded-lg bg-background shadow-lg"><AsyncQuestionCard itemId={question.itemId} questions={question.questions} /></div>}
    </div>
  );
}
