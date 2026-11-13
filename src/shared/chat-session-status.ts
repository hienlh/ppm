/**
 * `GET /api/chat/sessions/status`: per recent session across every registered project, enough
 * to decide whether it is waiting on the user, stopped, or idle since the AI's last answer.
 * Read-only: nothing here clears unread state.
 */
import type { SessionPhase } from "../types/api.ts";

export const STATUS_DEFAULT_SINCE_HOURS = 336;
export const STATUS_MAX_SINCE_HOURS = 2160;

export type ChatTurnOutcome = "running" | "done" | "cancelled" | "error" | "max_turns";

export interface ChatSessionPending {
  /** `question` for AskUserQuestion, else `approval`. */
  kind: "question" | "approval";
  tool: string;
  requestId: string;
  since: string;
}

export interface ChatSessionLastTurn {
  outcome: ChatTurnOutcome;
  at: string;
  /** For `error` and `max_turns`: the provider's words. */
  message?: string;
  subtype?: string;
}

export interface ChatSessionStatus {
  /** The session's current id, after any migration: the one to open its tab with. */
  sessionId: string;
  providerId: string;
  projectName: string;
  title: string | null;
  /** Newest trace row of the session. */
  updatedAt: string;
  phase: SessionPhase;
  /** Memory only: a pending request does not survive a server restart. */
  pending: ChatSessionPending | null;
  lastTurn: ChatSessionLastTurn | null;
  lastAnswerAt: string | null;
  lastUserMessageAt: string | null;
  userRepliedSinceAnswer: boolean;
  unreadType: string | null;
}

export interface ChatSessionStatusResponse {
  generatedAt: string;
  sessions: ChatSessionStatus[];
}
