/** Standard API response envelope — backend wraps all responses in this */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Helper to create success response */
export function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

/** Helper to create error response */
export function err(error: string): ApiResponse<never> {
  return { ok: false, error };
}

/** WebSocket message types (terminal) */
export type TerminalWsMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "output"; data: string };

/** WebSocket message types (chat) */
export type ChatWsClientMessage =
  | { type: "message"; content: string; permissionMode?: string; priority?: 'now' | 'next' | 'later'; images?: Array<{ data: string; mediaType: string }> }
  | { type: "cancel" }
  | { type: "approval_response"; requestId: string; approved: boolean; reason?: string; data?: unknown }
  | { type: "ready" };

/** Session phase for the 5-state machine (BE-owned) */
export type SessionPhase = "initializing" | "connecting" | "thinking" | "streaming" | "idle";

export type ChatWsServerMessage =
  | { type: "text"; content: string; parentToolUseId?: string }
  | { type: "thinking"; content: string; parentToolUseId?: string }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string; parentToolUseId?: string }
  | { type: "tool_result"; output: string; isError?: boolean; toolUseId?: string; parentToolUseId?: string }
  | { type: "approval_request"; requestId: string; tool: string; input: unknown }
  | { type: "done"; sessionId: string; contextWindowPct?: number }
  | { type: "error"; message: string }
  | { type: "account_info"; accountId: string; accountLabel: string }
  | { type: "phase_changed"; phase: SessionPhase; elapsed?: number }
  | { type: "session_state"; sessionId: string; phase: SessionPhase; pendingApproval: { requestId: string; tool: string; input: unknown } | null; sessionTitle: string | null }
  | { type: "turn_events"; events: unknown[] }
  | { type: "title_updated"; title: string }
  | { type: "ping" };
