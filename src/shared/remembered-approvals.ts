/**
 * Remembered approvals as every screen sees them: the rules the user made, what a card offers to
 * remember, and the one line a chat shows when a rule approved a request without a card.
 */
import type { ApprovalRuleKind } from "./remembered-approval-pattern.ts";

/** A card suggests remembering its kind of request after the user approved it this many times by hand. */
export const REMEMBER_SUGGEST_AFTER = 3;

/** What a card offers to remember, worked out on the server. */
export interface CardRememberOffer {
  /** "Run `git status`", "Open a new chat in this project". */
  label: string;
  /** The user approved this same kind by hand {@link REMEMBER_SUGGEST_AFTER} times: say so on the card. */
  suggest: boolean;
}

export interface RememberedApprovalRule {
  id: string;
  projectName: string;
  kind: ApprovalRuleKind;
  pattern: string;
  label: string;
  createdAt: number;
  /** `chat`, `assistant_card` or `telegram`: where the press that made it came from. */
  createdVia: string;
  lastUsedAt: number | null;
  useCount: number;
}

/** `GET /api/approval-rules`. */
export interface RememberedApprovalsState {
  enabled: boolean;
  rules: RememberedApprovalRule[];
}

/** The chat event a rule's approval leaves in the conversation, in place of a card. */
export interface AutoApprovedEvent {
  type: "auto_approved";
  requestId: string;
  tool: string;
  ruleId: string;
  /** What the rule approves, as the user named it by pressing ("Run `git status`"). */
  label: string;
}

/** The `/ws/global` event telling every tab the rules or the switch changed. */
export const REMEMBERED_APPROVALS_CHANGED_EVENT = "approvals:rules_changed";
