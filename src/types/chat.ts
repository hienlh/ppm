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
  budgetPace: number;
  resetsAt: string;
  resetsInMinutes: number | null;
  resetsInHours: number | null;
  windowHours: number;
  status: string;
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
}

/** Result subtype from SDK ResultMessage */
export type ResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_during_execution";

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string }
  | { type: "tool_result"; output: string; isError?: boolean; toolUseId?: string }
  | { type: "approval_request"; requestId: string; tool: string; input: unknown }
  | { type: "usage"; usage: UsageInfo }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; resultSubtype?: ResultSubtype; numTurns?: number };

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
}
