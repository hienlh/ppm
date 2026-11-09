/**
 * The cards a waiting tool call puts at the end of the transcript: a plain Allow/Deny for a tool
 * that needs approval (or a PPM Assistant endpoint's card, which says what will happen), the
 * question form for AskUserQuestion, a database change to approve, and a session tool's card.
 */
import { dbExecuteApprovalInput } from "../../../shared/db-ai-tools";
import type { AnswersById } from "../../../shared/approval-questions";
import { approvalQuestions, type ApprovalRequest } from "@/lib/approval-request";
import { QuestionCard } from "./question-card";
import { ApprovalCard } from "./approval-card";
import { DbExecuteApprovalCard } from "./db-execute-approval-card";
import { sessionCollabApprovalInput } from "../../../shared/session-collab";
import { CollabApprovalCard } from "./collab-approval-card";

/** A question card answers by question id; every other card only says yes or no. */
type Respond = (requestId: string, approved: boolean, answersById?: AnswersById) => void;

/** The card a waiting call needs: the question form, a database change to approve, or Allow/Deny. */
export function PendingApprovalCard({ approval, onRespond }: { approval: ApprovalRequest; onRespond: Respond }) {
  if (approval.tool === "AskUserQuestion") return <AskUserQuestionCard approval={approval} onRespond={onRespond} />;
  // PPM's own approvals are answered over HTTP by their own cards, never through `onRespond`.
  const db = dbExecuteApprovalInput(approval.tool, approval.input);
  if (db) return <DbExecuteApprovalCard requestId={approval.requestId} input={db} />;
  const collab = sessionCollabApprovalInput(approval.tool, approval.input);
  if (collab) return <CollabApprovalCard requestId={approval.requestId} input={collab} />;
  return <ApprovalCard approval={approval} onRespond={(id, approved) => onRespond(id, approved)} />;
}

/** Interactive quiz form for AskUserQuestion — renders questions with selectable options + Other */
export function AskUserQuestionCard({ approval, onRespond }: { approval: ApprovalRequest; onRespond: Respond }) {
  // Codex's questions arrive normalized beside an input the form cannot read; Claude's are read
  // off its tool input when the server sent none (an older server).
  const questions = approvalQuestions(approval);

  return (
    <QuestionCard
      questions={questions}
      onSubmit={(answersById) => onRespond(approval.requestId, true, answersById)}
      onSkip={() => onRespond(approval.requestId, false)}
    />
  );
}
