import type { ApprovalSummary } from "../../shared/assistant-approval";

/**
 * The approval card a chat shows, read from the server's `approval_request` and from
 * `session_state.pendingApproval`. The server is the authority on which card is waiting: a
 * greeting that says none (`null`) takes the card away — after a restart nothing waits on it,
 * and a card left up would let a click look as if it ran something.
 */

export interface ApprovalRequest {
  requestId: string;
  tool: string;
  input: unknown;
  /** Set on a PPM Assistant endpoint card: what will happen, as the server built it. */
  summary?: ApprovalSummary;
}

function summaryFromWire(raw: unknown): ApprovalSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Partial<ApprovalSummary>;
  if (typeof s.headline !== "string" || !Array.isArray(s.facts)) return undefined;
  return {
    headline: s.headline,
    facts: s.facts.filter((f) => f && typeof f.label === "string" && typeof f.value === "string")
      .map((f) => ({ label: f.label, value: f.value, ...(f.tone === "warning" ? { tone: "warning" as const } : {}) })),
    ...(s.body && typeof s.body.text === "string" && typeof s.body.label === "string"
      ? { body: { label: s.body.label, text: s.body.text, format: s.body.format === "sql" ? "sql" as const : "text" as const } } : {}),
    ...(typeof s.statementCount === "number" ? { statementCount: s.statementCount } : {}),
    ...(typeof s.warning === "string" ? { warning: s.warning } : {}),
  };
}

/** The card a wire event describes, or null when it describes none. */
export function approvalFromWire(raw: unknown): ApprovalRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== "string" || !r.requestId) return null;
  const summary = summaryFromWire(r.summary);
  return { requestId: r.requestId, tool: typeof r.tool === "string" ? r.tool : "Tool", input: r.input, ...(summary ? { summary } : {}) };
}

/**
 * The card to show after a `session_state` greeting: the one it names, none when it says none,
 * the current one when the greeting does not say (an older server).
 */
export function approvalAfterGreeting(current: ApprovalRequest | null, state: Record<string, unknown>): ApprovalRequest | null {
  if (!("pendingApproval" in state)) return current;
  return approvalFromWire(state.pendingApproval);
}
