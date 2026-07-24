// Native PPM group-chat engine — shared domain types.
// Message bus is a single table keyed by `kind` + JSON `data` (spike-validated).

export type GroupStatus = "active" | "paused" | "idle";
export type MemberRole = "leader" | "member";
export type MemberStatus = "idle" | "working" | "done" | "error";
export type MessageKind = "task" | "chat" | "status" | "completion" | "final";

export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_MAX_COST_USD = 5.0;

export interface Group {
  id: string;
  projectName: string;
  projectPath: string;
  name: string;
  leaderSessionId: string | null;
  status: GroupStatus;
  maxTurns: number;
  maxCostUsd: number;
  createdAt: number;
}

export interface GroupMember {
  id: string;
  groupId: string;
  role: MemberRole;
  persona: string | null;
  agentType: string | null;
  model: string | null;
  sessionId: string | null;
  name: string;
  color: string | null;
  status: MemberStatus;
  joinedAt: number;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  fromMember: string;
  toMember: string | null;
  kind: MessageKind;
  summary: string | null;
  fullSessionRef: string | null;
  data: unknown;
  turnIndex: number;
  createdAt: number;
}

export interface CreateGroupInput {
  projectName: string;
  projectPath: string;
  name: string;
  maxTurns?: number;
  maxCostUsd?: number;
}

export interface AddMemberInput {
  groupId: string;
  role: MemberRole;
  name: string;
  persona?: string | null;
  agentType?: string | null;
  model?: string | null;
  color?: string | null;
}

export interface AppendMessageInput {
  groupId: string;
  fromMember: string;
  toMember?: string | null;
  kind: MessageKind;
  summary?: string | null;
  fullSessionRef?: string | null;
  data?: unknown;
  turnIndex: number;
}

export interface ReadMessagesOptions {
  limit?: number;
  sinceTurn?: number;
}

// ---------------------------------------------------------------------------
// Turn engine
// ---------------------------------------------------------------------------

export interface AgentTurnResult {
  text: string;
  usage?: { costUsd?: number };
}

/** Injected dependencies — engine never imports a provider directly (testable). */
export interface TurnEngineDeps {
  /** Run one turn for a member's session with a prompt; returns full text + usage. */
  runAgent: (member: GroupMember, prompt: string) => Promise<AgentTurnResult>;
  /** Persist a turn to the bus. */
  appendMessage: (input: AppendMessageInput) => GroupMessage;
  /** Read prior bus messages (for windowed context). */
  readMessages: (groupId: string, opts?: ReadMessagesOptions) => GroupMessage[];
  /** Emit a turn to live listeners (WS broadcast). Optional. */
  onMessage?: (message: GroupMessage) => void;
  /** External stop signal (user Stop / abort). Checked before each turn. */
  shouldStop?: () => boolean;
}

export type TerminationReason = "leader_done" | "max_turns" | "budget" | "stopped";

export interface TurnLoopResult {
  reason: TerminationReason;
  turns: number;
  costUsd: number;
}
