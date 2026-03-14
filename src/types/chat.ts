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
  providerId: string;
  title: string;
  projectName?: string;
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

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "tool_result"; output: string }
  | { type: "approval_request"; requestId: string; tool: string; input: unknown }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string };

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
