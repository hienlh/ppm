import { AlertCircle, ShieldAlert } from "@/lib/icons";
import type { ApprovalSummary } from "../../../shared/assistant-approval";

/**
 * The card a chat shows while a tool waits on the user's approval. A provider's card shows the
 * tool's raw input; a PPM Assistant endpoint card shows what the server says will happen — its
 * summary line, the facts it checked (connection, chat, the mode a message runs in) and the full
 * SQL or message — never the agent's description of it. Everything wraps: a long statement or
 * command must be readable to its last word without scrolling sideways, where a `DROP` could hide.
 */

export interface ApprovalCardRequest {
  requestId: string;
  tool: string;
  input: unknown;
  summary?: ApprovalSummary;
}

const WRAPPED_BLOCK = "text-xs font-mono whitespace-pre-wrap break-words bg-background rounded p-2 border border-border max-h-80 overflow-y-auto select-text";

function SummaryBody({ summary }: { summary: ApprovalSummary }) {
  return (
    <>
      <p className="text-sm text-text-primary">{summary.headline}</p>
      {summary.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {summary.facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-text-secondary">{f.label}</dt>
              <dd className={f.tone === "warning" ? "font-medium text-warning break-words" : "text-text-primary break-words"}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {summary.body && (
        <div className="space-y-1">
          <div className="text-xs text-text-secondary">
            {summary.body.label}
            {summary.statementCount != null && ` · ${summary.statementCount} statement${summary.statementCount === 1 ? "" : "s"}`}
          </div>
          <pre className={`${WRAPPED_BLOCK} ${summary.body.format === "sql" ? "text-text-primary" : "font-sans text-text-primary"}`}>
            {summary.body.text}
          </pre>
        </div>
      )}
      {summary.warning && (
        <div className="flex items-start gap-2 rounded border border-warning/50 bg-warning/15 px-2 py-1.5 text-xs font-medium text-warning">
          <AlertCircle className="size-4 shrink-0" />
          <span className="break-words">{summary.warning}</span>
        </div>
      )}
    </>
  );
}

export function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: ApprovalCardRequest;
  onRespond: (requestId: string, approved: boolean, data?: unknown) => void;
}) {
  const summary = approval.summary;
  return (
    <div className="rounded-lg border-2 border-warning/40 bg-warning/10 p-3 space-y-2" data-approval-request={approval.requestId}>
      <div className="flex items-center gap-2 text-warning text-sm font-medium">
        <ShieldAlert className="size-4" />
        <span>{summary ? "PPM Assistant asks for approval" : "Tool Approval Required"}</span>
      </div>
      {summary ? <SummaryBody summary={summary} /> : (
        <>
          <div className="text-xs text-text-primary">
            <span className="font-medium">{approval.tool}</span>
          </div>
          <pre className={`${WRAPPED_BLOCK} text-text-secondary`}>
            {JSON.stringify(approval.input, null, 2)}
          </pre>
        </>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => onRespond(approval.requestId, true)}
          className="min-h-11 md:min-h-0 px-4 py-1.5 rounded bg-success text-white text-xs font-medium hover:bg-success/80 transition-colors"
        >
          Allow
        </button>
        <button
          onClick={() => onRespond(approval.requestId, false)}
          className="min-h-11 md:min-h-0 px-4 py-1.5 rounded bg-error text-white text-xs font-medium hover:bg-error/80 transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
