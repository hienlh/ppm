export interface SendMessageOpts {
  permissionMode?: import("./config").PermissionMode | string;
}

export interface AIProvider {
  id: string;
  name: string;
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: string): Promise<Session>;
  listSessions(): Promise<SessionInfo[]>;
  deleteSession(sessionId: string): Promise<void>;
  sendMessage(
    sessionId: string,
    message: string,
    opts?: SendMessageOpts,
  ): AsyncIterable<ChatEvent>;
  /** Resolve a pending tool/question approval by requestId */
  resolveApproval?(requestId: string, approved: boolean, data?: unknown): void;
  onToolApproval?: (callback: ToolApprovalHandler) => void;
}

export interface Session {
  id: string;
  providerId: string;
  title: string;
  projectName?: string;
  projectPath?: string;
  createdAt: string;
}

export interface SessionConfig {
  providerId?: string;
  projectName?: string;
  projectPath?: string;
  title?: string;
}

export interface SessionInfo {
  id: string;
  providerId: string;
  title: string;
  projectName?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface LimitBucket {
  utilization: number;
  resetsAt: string;
  resetsInMinutes: number | null;
  resetsInHours: number | null;
  windowHours: number;
}

export interface UsageInfo {
  /** Cumulative cost across the session */
  totalCostUsd?: number;
  /** Cost of the last query only (resets each query) */
  queryCostUsd?: number;
  /** 0–1 utilization for five_hour limit */
  fiveHour?: number;
  /** 0–1 utilization for seven_day limit */
  sevenDay?: number;
  /** ISO timestamp when five_hour limit resets */
  fiveHourResetsAt?: string;
  /** ISO timestamp when seven_day limit resets */
  sevenDayResetsAt?: string;
  /** Detailed limit buckets from ccburn */
  session?: LimitBucket;
  weekly?: LimitBucket;
  weeklyOpus?: LimitBucket;
  weeklySonnet?: LimitBucket;
  activeAccountId?: string;
  activeAccountLabel?: string;
}

/** Result subtype from SDK ResultMessage */
export type ResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_during_execution";

export type ChatEvent =
  | { type: "text"; content: string; parentToolUseId?: string }
  | { type: "thinking"; content: string; parentToolUseId?: string }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string; parentToolUseId?: string; children?: ChatEvent[] }
  | { type: "tool_result"; output: string; isError?: boolean; toolUseId?: string; parentToolUseId?: string }
  | { type: "approval_request"; requestId: string; tool: string; input: unknown }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; resultSubtype?: ResultSubtype; numTurns?: number; contextWindowPct?: number }
  | { type: "account_info"; accountId: string; accountLabel: string };

export type ToolApprovalHandler = (
  tool: string,
  input: unknown,
) => Promise<{ approved: boolean; reason?: string }>;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  events?: ChatEvent[];
  timestamp: string;
  /** Account used to generate this assistant message */
  accountId?: string;
  accountLabel?: string;
}
