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
  | { type: "message"; content: string }
  | { type: "cancel" }
  | { type: "approval_response"; requestId: string; approved: boolean; reason?: string; data?: unknown };

export type ChatWsServerMessage =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "tool_result"; output: string; isError?: boolean }
  | { type: "approval_request"; requestId: string; tool: string; input: unknown }
  | { type: "usage"; usage: { totalCostUsd?: number; fiveHour?: number; sevenDay?: number } }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string };
