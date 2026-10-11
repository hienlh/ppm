/**
 * Approval cards the PPM Assistant's tool endpoint puts in front of the user, shared by the
 * server that builds them and the chat that shows them.
 *
 * A provider's own card (Claude's Bash, Codex's shell command) carries the tool's raw input.
 * An endpoint card carries a {@link ApprovalSummary} as well: what will happen, built by the
 * server from input it has already checked, never from words the agent chose — so the card
 * says what will run, not what the agent claims will run.
 */

/** One labelled fact on a card: the connection, the project, the mode a message runs in. */
export interface ApprovalFact {
  label: string;
  value: string;
  /** Shown highlighted: a fact the user should not miss (a chat that runs every tool unasked). */
  tone?: "warning";
}

export interface ApprovalSummary {
  /** One line saying what will happen. */
  headline: string;
  facts: ApprovalFact[];
  /** The exact text that will run or be sent, shown in full and wrapped. */
  body?: { label: string; text: string; format: "sql" | "text" };
  /** How many SQL statements `body` holds. */
  statementCount?: number;
  /** A line shown highlighted above the buttons. */
  warning?: string;
}

/** An endpoint card on the wire, as `approval_request` and as `session_state.pendingApproval`. */
export interface EndpointApprovalRequest {
  type: "approval_request";
  requestId: string;
  tool: string;
  input: unknown;
  summary: ApprovalSummary;
  /** Marks a card the Assistant's tool endpoint holds, as opposed to a provider's own. */
  origin: "endpoint";
}

/**
 * The answer to an `approval_response` nothing is waiting for any more — answered on another
 * device, timed out, withdrawn, or left behind by a server restart. Nothing ran.
 */
export interface ApprovalStaleMessage {
  type: "approval_stale";
  requestId: string;
  message: string;
}

export const APPROVAL_NO_LONGER_VALID_MESSAGE =
  "This approval request is no longer valid — it was already answered, timed out or withdrawn, or PPM restarted. Nothing was run.";
