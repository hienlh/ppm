export interface SendMessageOpts {
  permissionMode?: import("./config").PermissionMode | string;
  priority?: 'now' | 'next' | 'later';
  images?: Array<{ data: string; mediaType: string }>;
}

export interface AIProvider {
  id: string;
  name: string;

  // Session lifecycle (required)
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: string): Promise<Session>;
  listSessions(): Promise<SessionInfo[]>;
  deleteSession(sessionId: string): Promise<void>;

  // Streaming (required)
  sendMessage(
    sessionId: string,
    message: string,
    opts?: SendMessageOpts,
  ): AsyncIterable<ChatEvent>;

  // Optional capabilities — providers implement what they support
  resolveApproval?(requestId: string, approved: boolean, data?: unknown): void;
  onToolApproval?: (callback: ToolApprovalHandler) => void;
  abortQuery?(sessionId: string): void;
  getMessages?(sessionId: string): Promise<ChatMessage[]>;
  listSessionsByDir?(dir: string, opts?: { limit?: number; offset?: number }): Promise<SessionInfo[]>;
  ensureProjectPath?(sessionId: string, path: string): void;
  setForkSource?(sessionId: string, sourceSessionId: string): void;
  forkAtMessage?(sessionId: string, messageId: string, opts?: { title?: string; dir?: string }): Promise<{ sessionId: string }>;
  markAsResumed?(sessionId: string): void;
  isAvailable?(): Promise<boolean>;
  listModels?(): Promise<ModelOption[]>;
}

export interface ModelOption {
  value: string;
  label: string;
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

export interface ProjectTag {
  id: number;
  projectPath: string;
  name: string;
  color: string;
  sortOrder: number;
}

export interface SessionInfo {
  id: string;
  providerId: string;
  title: string;
  projectName?: string;
  createdAt: string;
  updatedAt?: string;
  pinned?: boolean;
  tag?: { id: number; name: string; color: string } | null;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
  hasMore: boolean;
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
  | "error_during_execution"
  | "error_auth";

export type ChatEvent =
  | { type: "text"; content: string; parentToolUseId?: string }
  | { type: "thinking"; content: string; parentToolUseId?: string }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string; parentToolUseId?: string; children?: ChatEvent[] }
  | { type: "tool_result"; output: string; isError?: boolean; toolUseId?: string; parentToolUseId?: string }
  | { type: "approval_request"; requestId: string; tool: string; input: unknown }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; resultSubtype?: ResultSubtype; numTurns?: number; contextWindowPct?: number; lastMessageUuid?: string }
  | { type: "account_info"; accountId: string; accountLabel: string }
  | { type: "account_retry"; reason: string; accountId?: string; accountLabel?: string }
  | { type: "status_update"; phase: "routing" | "refreshing" | "switching"; message: string; accountLabel?: string }
  | { type: "system"; subtype: string }
  | { type: "team_detected"; teamName: string }
  | { type: "team_updated"; teamName: string; team: unknown }
  | { type: "team_inbox"; teamName: string; agent: string; messages: unknown[] }
  | { type: "session_migrated"; oldSessionId: string; newSessionId: string };

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
  /** SDK message UUID — used for fork/rewind (maps to JSONL message IDs) */
  sdkUuid?: string;
}
