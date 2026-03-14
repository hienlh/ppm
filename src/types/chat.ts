/** AI provider interface — generic, multi-provider ready */
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
  onToolApproval?: (callback: ToolApprovalHandler) => void;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
}

export interface SessionConfig {
  title?: string;
  projectPath?: string;
  systemPrompt?: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: string;
  messageCount: number;
}

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "tool_result"; output: string }
  | { type: "approval_request"; tool: string; input: unknown; requestId: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string };

export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
) => Promise<boolean>;

export interface ToolApprovalRequest {
  requestId: string;
  tool: string;
  input: unknown;
  sessionId: string;
}
