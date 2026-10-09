import type { ReplyReference } from "../shared/chat-reply.ts";
import type { TabOpenRequest, TabOpenResult } from "../shared/tab-open-protocol.ts";
import type { AssistantUiRequest, AssistantUiResult, UiSummary } from "../shared/assistant-ui-protocol.ts";
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
  | { type: "message"; clientMessageId?: string; content: string; replyTo?: ReplyReference | null; permissionMode?: string; priority?: 'now' | 'next' | 'later'; images?: Array<{ data: string; mediaType: string }>;
  /** Uploaded paths for the same images, for providers that take a file not a payload. */
  imagePaths?: string[]; model?: string; effort?: string; thinking?: boolean;
  /** An Assistant session's message: what the sending device shows, validated by the server. */
  uiSummary?: UiSummary }
  | { type: "cancel" }
  | { type: "set_model"; model: string }
  | { type: "set_effort"; effort: string }
  | { type: "set_thinking"; enabled: boolean }
  | { type: "approval_response"; requestId: string; approved: boolean; reason?: string; data?: unknown }
  | { type: "kill_background_shell"; shellId: string }
  | { type: "ready" }
  /** Replay an in-progress turn after a downstream WebSocket content gap. */
  | { type: "resync" }
  /** A device's answer to `tab_open`. */
  | TabOpenResult
  /** A device's answer to `assistant_ui`. */
  | AssistantUiResult;

/** A background command (SDK Bash run_in_background) tracked for the current session. */
export interface BackgroundShell {
  shellId: string;
  command: string;
  /** Absolute path to the SDK's .output file (resolved by the spy). */
  outputPath: string;
  /** SDK tool_use id — used to correlate live bash_output deltas. */
  toolUseId: string;
  status: "running" | "stopping" | "stopped";
  startedAt: number;
}

/** Session phase for the 5-state machine (BE-owned) */
export type SessionPhase = "initializing" | "connecting" | "thinking" | "streaming" | "idle";

/** One group of edited versions of the same user message. Part of the
 *  GET /chat/sessions/:id/messages response, keyed by user-message ordinal. */
export interface VersionGroup {
  /** Ordered version session ids: parent (v1 / original) first, then children oldest-first. */
  ids: string[];
  /** Position of the queried session within `ids`. */
  currentIndex: number;
}

export type ChatWsServerMessage =
  | { type: "text"; content: string; parentToolUseId?: string }
  | { type: "thinking"; content: string; parentToolUseId?: string }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string; parentToolUseId?: string }
  | { type: "tool_result"; output: string; isError?: boolean; exitCode?: number; toolUseId?: string; parentToolUseId?: string }
  | { type: "bash_output"; toolUseId: string; content: string; lineCount: number }
  | { type: "background_registry"; sessionId: string; shells: BackgroundShell[] }
  | { type: "subagent_status"; toolUseId: string; status: import("../shared/background-agent-status").BackgroundAgentStatus }
  | { type: "approval_request"; requestId: string; tool: string; input: unknown; summary?: import("../shared/assistant-approval").ApprovalSummary; origin?: "endpoint" }
  /** This device answered an approval nothing waits on any more; nothing ran. */
  | import("../shared/assistant-approval").ApprovalStaleMessage
  | { type: "done"; sessionId: string; contextWindowPct?: number }
  | { type: "error"; message: string }
  | { type: "account_info"; accountId: string; accountLabel: string }
  | { type: "phase_changed"; phase: SessionPhase; elapsed?: number }
  | { type: "session_state"; sessionId: string; phase: SessionPhase; pendingApproval: { requestId: string; tool: string; input: unknown; summary?: import("../shared/assistant-approval").ApprovalSummary } | null; sessionTitle: string | null; model?: string; effort?: string; thinking?: boolean; turnStop?: import("../shared/turn-stop").TurnStop | null }
  /** The turn that just ended was ended by an error. Sent just before its `done`. */
  | { type: "turn_stop"; stop: import("../shared/turn-stop").TurnStop }
  | { type: "turn_events"; events: unknown[]; streamSeq?: number; truncated?: boolean }
  | { type: "message_rejected"; clientMessageId?: string; content: string; replyTo?: ReplyReference | null; message: string }
  | { type: "user_message"; content: string; imageCount?: number; timestamp?: string }
  /** An AI tab tool asks this device to open a tab. */
  | TabOpenRequest
  /** A PPM Assistant UI tool asks the device chatting in the session to read or act on its screen. */
  | AssistantUiRequest
  | { type: "title_updated"; title: string }
  | { type: "compact_status"; status: "compacting" | "done" }
  | { type: "ping"; streamSeq?: number };
