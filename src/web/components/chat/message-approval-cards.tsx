/**
 * The cards a waiting tool call puts at the end of the transcript: a plain Allow/Deny for a tool
 * that needs approval, and the question form for AskUserQuestion.
 */
import { ShieldAlert } from "@/lib/icons";
import { QuestionCard, type Question } from "./question-card";

interface Approval {
  requestId: string;
  tool: string;
  input: unknown;
}

type Respond = (requestId: string, approved: boolean, data?: unknown) => void;

export function ApprovalCard({ approval, onRespond }: { approval: Approval; onRespond: Respond }) {
  return (
    <div className="rounded-lg border-2 border-warning/40 bg-warning/10 p-3 space-y-2">
      <div className="flex items-center gap-2 text-warning text-sm font-medium">
        <ShieldAlert className="size-4" />
        <span>Tool Approval Required</span>
      </div>
      <div className="text-xs text-text-primary">
        <span className="font-medium">{approval.tool}</span>
      </div>
      <pre className="text-xs font-mono text-text-secondary overflow-x-auto bg-background rounded p-2 border border-border">
        {JSON.stringify(approval.input, null, 2)}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={() => onRespond(approval.requestId, true)}
          className="px-4 py-1.5 rounded bg-success text-white text-xs font-medium hover:bg-success/80 transition-colors"
        >
          Allow
        </button>
        <button
          onClick={() => onRespond(approval.requestId, false)}
          className="px-4 py-1.5 rounded bg-error text-white text-xs font-medium hover:bg-error/80 transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/** Interactive quiz form for AskUserQuestion — renders questions with selectable options + Other */
export function AskUserQuestionCard({ approval, onRespond }: { approval: Approval; onRespond: Respond }) {
  const input = approval.input as { questions?: Question[] };
  const questions = input.questions ?? [];

  return (
    <QuestionCard
      questions={questions}
      onSubmit={(answers) => onRespond(approval.requestId, true, answers)}
      onSkip={() => onRespond(approval.requestId, false)}
    />
  );
}
